"""Read-only independent admission adapter for reviewed-controller.v2 packets.

This adapter recognizes native comment, document, interaction and execution-
decision identities separately. No package-provided permission is sufficient.
"""
import copy
import datetime
import re
from contracts import require, closed_json, canonical, digest, AdmissionWait


def first_json(body):
    match = re.search(r"```json\s*(.*?)\s*```", body, re.S)
    require(match is not None, "native_structured_record_missing")
    return closed_json(match[1])


def instant(value):
    result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(result.tzinfo is not None, 'native_timestamp_without_zone')
    return result


class ReviewAdmissionService:
    def __init__(self, native):
        self.native = native

    def assert_profile(self, job, profile):
        require(job["companyId"] == profile["companyId"] and job["projectId"] == profile["projectId"] and
                job["taskId"] in profile["taskIds"] and job["agentId"] == profile["agentId"], "job_profile_scope_mismatch")
        pinned = profile.get("controlPacket")
        if job["kind"] == "control_checks" and pinned is not None:
            require(all(job[field] == value for field, value in pinned.items()), "job_control_packet_mismatch")

    def binding(self, job, profile):
        self.assert_profile(job, profile)
        issue = self.native.read("/api/issues/" + job["taskId"])
        require(issue["companyId"] == job["companyId"] and issue["projectId"] == job["projectId"] and
                issue["assigneeAgentId"] == job["agentId"] and issue["status"] not in ["done", "cancelled", "backlog"],
                "job_task_ownership_changed")
        agent = self.native.read("/api/agents/" + job["agentId"])
        require(agent["companyId"] == job["companyId"] and agent["status"] not in ["paused", "terminated"], "job_agent_unavailable")
        gates = self.native.admission_gates(job['companyId'], job['taskId'])
        require(gates['companyActive'] is True and gates['projectActive'] is True and gates['pauseHeld'] is False,
                'job_native_pause_hold')
        require(not issue.get('executionBlocker') and not any(x['status'] != 'done' for x in issue.get('blockedBy', [])),
                'job_native_execution_hold')
        require(issue["status"] in ["todo", "in_progress", "in_review"], "job_native_execution_hold")
        return issue

    def revision_authored(self, issue_id, key, document, actor_id, run_id):
        from contracts import UUID
        require(UUID.fullmatch(document['latestRevisionId']) and UUID.fullmatch(run_id), 'job_document_revision_invalid')
        revision = self.native.read(f"/api/issues/{issue_id}/documents/{key}/revisions/{document['latestRevisionId']}")
        require(revision.get('id') == document['latestRevisionId'] and revision.get('isLatest') is True and
                revision.get('issueId') == issue_id and revision.get('key') == key and
                revision.get('companyId') == document['companyId'] and revision.get('body') == document['body'] and
                revision.get('createdByAgentId') == actor_id and revision.get('createdByRunId') == run_id,
                'job_document_revision_author_mismatch')

    def root_approval(self, job, profile):
        # Root privilege is accepted independently for an exact operator code
        # template. A lead-authored packet review alone cannot grant it.
        root_policy = profile['privilegedCodeApproval']
        root_approval = self.native.read(f'/api/issues/{root_policy["issueId"]}/documents/{root_policy["documentKey"]}')
        try:
            root_value = first_json(root_approval['body'])
        except Exception:
            raise AdmissionWait('job_root_template_not_accepted') from None
        accepted = (root_approval['companyId'] == job['companyId'] and
                root_approval['updatedByAgentId'] == root_policy['reviewerAgentId'] and
                root_value.get('kind') == 'operator_root_template' and root_value.get('approved') is True and
                root_value.get('companyId') == job['companyId'] and root_value.get('projectId') == job['projectId'] and
                root_value.get('codeManifestSha256') == digest(profile['privilegedCodeDigests']))
        if not accepted:
            raise AdmissionWait('job_root_template_not_accepted')
        self.revision_authored(root_policy['issueId'], root_policy['documentKey'], root_approval,
                               root_policy['reviewerAgentId'], root_value['reviewerRunId'])
        return root_policy, root_approval, root_value

    def controller(self, job, profile, packet):
        self.binding(job, profile)
        require(packet.trial['harnessIssueId'] == job['taskId'], 'job_packet_task_binding_invalid')
        root_policy, root_approval, root_value = self.root_approval(job, profile)
        scope = self.native.comment(job["scopeIssueId"], job["scopeCommentId"])
        ack = self.native.comment(job["taskId"], job["ackCommentId"])
        require(scope["companyId"] == ack["companyId"] == job["companyId"] and
                scope["authorAgentId"] == profile["scopeAgentId"] and ack["authorAgentId"] == job["agentId"] and
                scope["deletedAt"] is ack["deletedAt"] is None and instant(scope["createdAt"]) < instant(ack["createdAt"]), "job_native_scope_invalid")
        require(scope["issueId"] in profile["scopeIssueIds"], "job_scope_issue_not_registered")
        target = self.native.read(f'/api/issues/{job["taskId"]}/documents/{profile["targetDocumentKey"]}')
        acp = self.native.read(f'/api/issues/{job["taskId"]}/documents/{profile["actualAcpDocumentKey"]}')
        S, A, C = first_json(scope["body"]), first_json(ack["body"]), first_json(acp["body"])
        root_acceptance = {'kind': 'issue_document_revision', 'issueId': root_policy['issueId'],
                           'documentKey': root_policy['documentKey'], 'revisionId': root_approval['latestRevisionId'],
                           'reviewerAgentId': root_policy['reviewerAgentId'], 'codeManifestSha256': digest(profile['privilegedCodeDigests'])}
        require(S['rootPrivilegeAcceptance'] == A['rootPrivilegeAcceptance'] == root_acceptance,
                'job_scope_root_template_not_accepted')
        expected_scope = {**S, "kind": "issue_comment", "issueId": scope["issueId"],
                          "commentId": scope["id"], "authorAgentId": profile["scopeAgentId"]}
        require(A["continuationScope"] == expected_scope and
                C == {k: v for k, v in A["actualAcpReview"].items() if k != "documentRevisionId"} and
                A["actualAcpReview"]["documentRevisionId"] == acp["latestRevisionId"] == S["actualAcpDocumentRevisionId"],
                "job_scope_ack_acp_mismatch")
        require(acp["updatedByAgentId"] == profile["scopeAgentId"], "job_acp_receipt_provenance_invalid")
        for value in [S, A, C, A["nativeReview"]]:
            require(value["wholePacketSha256"] == job["packetSha256"], "job_review_packet_mismatch")
        contract = packet.contract
        require(A["candidate"] == profile["candidate"] and A["continuationId"] == packet.trial["continuationId"] and
                A["attempt"] == A["maxAttempts"] == 1 and
                A["mode"] == S["mode"] == C["mode"] == contract["mode"] and
                contract["mode"] in profile["allowedModes"] and
                S["decision"] == contract["remainingScopeDecision"] and
                A["phaseOrder"] == contract["phaseOrder"], "job_execution_scope_mismatch")
        require(A["scopeContractSha256"] == packet.file_sha(packet.directory + "/scope-contract.json") and
                A["recipeManifestSha256"] == packet.file_sha(packet.directory + "/reviewed-manifest.json") and
                A["casePackageSha256"] == packet.file_sha(packet.case_name), "job_execution_hash_mismatch")
        require(S["targetDocumentRevisionId"] == C["targetDocumentRevisionId"] ==
                A["nativeReview"]["targetDocumentRevisionId"] == target["latestRevisionId"], "job_review_target_superseded")
        require(S["verdictDocumentRevisionId"] == C["verdictDocumentRevisionId"] ==
                A["nativeReview"]["documentRevisionId"], "job_verdict_identity_mismatch")
        verdict = self.native.read(f'/api/issues/{job["taskId"]}/documents/{profile["reviewDocumentKey"]}')
        require(verdict["latestRevisionId"] == C["verdictDocumentRevisionId"], "job_verdict_superseded")
        V = first_json(verdict['body'])
        require(verdict['updatedByAgentId'] == C['reviewerAgentId'] and
                V['wholePacketSha256'] == job['packetSha256'] and V['outcome'] == 'approved' and
                V['reviewerRunId'] == C['reviewerRunId'] and
                V['targetDocumentRevisionId'] == target['latestRevisionId'], 'job_reviewer_packet_binding_missing')
        self.revision_authored(job['taskId'], profile['reviewDocumentKey'], verdict, C['reviewerAgentId'], C['reviewerRunId'])
        interactions = self.native.read(f'/api/issues/{job["taskId"]}/interactions')
        matches = [x for x in interactions if x["id"] == S["nativeReviewInteractionId"] == C["interactionId"]]
        require(len(matches) == 1, "job_native_review_missing")
        review = matches[0]
        require(review["status"] == review["result"]["outcome"] == "accepted" and
                review["resolvedByRunId"] == C["reviewerRunId"] == A["nativeReview"]["resolvedByRunId"] and
                review["resolvedByAgentId"] == C["reviewerAgentId"] == A["nativeReview"]["resolvedByAgentId"] and
                review["resolvedByAgentId"] in profile["reviewerAgentIds"] and
                review["createdByAgentId"] == job["agentId"] and
                review["effectiveResolverPolicy"] == "not_creator" and
                review["payload"]["target"]["revisionId"] == target["latestRevisionId"], "job_independent_review_invalid")
        source = profile["sourceAuthority"]
        require(S["acceptedSourceLineage"] == source["sourceLineage"]["contract"] and
                A["sourceLineageHistoricalEvidence"] == {k: source["sourceLineage"][k] for k in
                    ["historicalPacketSha256", "documentationErrataSha256"]}, "job_source_lineage_mismatch")
        authors = packet.json("author-provider-ledger.json")["rows"]
        ids = {x["runId"] for x in authors} | {root_value['reviewerRunId'], C["reviewerRunId"], scope["createdByRunId"], ack["createdByRunId"], job["sourceRunId"]}
        records = self.native.metadata(job["companyId"], sorted(ids), list(profile["sourceDecisionFingerprints"]))
        runs = {x["id"]: x for x in records if x["kind"] == "run"}
        require(set(runs) == ids, "job_run_attestation_missing")
        security_run = runs[root_value['reviewerRunId']]
        require(security_run['status'] == 'succeeded' and security_run['task'] == root_policy['issueId'] and
                security_run['agent'] == root_policy['reviewerAgentId'] and
                security_run['agent'] not in [job['agentId'], profile['scopeAgentId']] and
                instant(security_run['finished']) < instant(scope['createdAt']), 'job_root_security_identity_invalid')
        actual = runs[C["reviewerRunId"]]
        require(actual["status"] == "succeeded" and actual["agent"] == C["reviewerAgentId"] and
                actual["provider"] == C["provider"] == "anthropic" and actual["actualACP"] is True and
                actual["before"] == actual["after"] == C["sessionId"] == profile['savedSessions'][actual['agent']] and
                instant(actual["finished"]) < instant(scope["createdAt"]), "job_actual_acp_not_verified")
        for author in authors:
            row = runs[author["runId"]]
            require(row["provider"] == author["aiConnection.provider"] and row["provider"] != actual["provider"] and
                    row["agent"] != actual["agent"], "job_review_not_independent")
        for identity, actor in [(scope["createdByRunId"], profile["scopeAgentId"]),
                                (ack["createdByRunId"], job["agentId"]), (job["sourceRunId"], job["agentId"])]:
            row = runs[identity]
            require(row["agent"] == actor and row["status"] == "succeeded" and row["before"] and
                    row["before"] == row["after"] == profile["savedSessions"][actor], "job_session_or_source_run_not_settled")
        decisions = {x["id"]: {k: v for k, v in x.items() if k != "kind"} for x in records if x["kind"] == "decision"}
        require(decisions == profile["sourceDecisionFingerprints"], "job_source_decisions_changed")
        A["remainingCaseContractSha256"] = A["scopeContractSha256"]
        A.update(schema=packet.authority_schema, operatorVerifiedAuthorities=True, harnessIssueId=job["taskId"],
                 underlyingImplementerProvider=authors[-1]["aiConnection.provider"], underlyingReviewerProvider=actual["provider"],
                 remainingScopeDecision=S["decision"], phpTestCalls=0, sourceCopies=0, dependencyCopies=0,
                 baselineSourceApproval=copy.deepcopy(source["baselineSourceApproval"]), sourceLineage=copy.deepcopy(source["sourceLineage"]),
                 qaAcknowledgement={"kind": "issue_comment", "issueId": job["taskId"], "commentId": ack["id"],
                                    "authorAgentId": job["agentId"], "wholePacketSha256": job["packetSha256"]})
        keys = ["nativeReview", "continuationScope", "baselineSourceApproval", "sourceLineage", "qaAcknowledgement", "actualAcpReview",
                "wholePacketSha256", "casePackageSha256", "recipeManifestSha256", "remainingCaseContractSha256", "remainingScopeDecision",
                "continuationId", "harnessIssueId", "attempt", "maxAttempts", "phpTestCalls", "sourceCopies", "dependencyCopies"]
        B = {k: A[k] for k in keys}
        B.update(mode=A["mode"], functionalCasesStarted=A["functionalCasesStarted"], featurePassed=A["featurePassed"],
                 nativeScopeCommentId=scope["id"], trialId=packet.trial["trialId"], candidate=profile["candidate"], approved=True)
        require(len(canonical(A)) < 32768 and len(canonical(B)) < 32768, "job_authority_record_too_large")
        return {"authority": A, "admission": B, "nativeBindingsSha256": digest([S, A["actualAcpReview"], decisions])}
