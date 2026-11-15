import copy
import json
import pathlib
import sys
import unittest
import uuid
from types import SimpleNamespace
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from admission import ReviewAdmissionService, instant
from contracts import Refusal
from test_repository import request


def fixture():
    job = request()
    lead, reviewer = str(uuid.uuid4()), str(uuid.uuid4())
    target, verdict, acp, interaction = [str(uuid.uuid4()) for _ in range(4)]
    review_run, scope_run, ack_run, author_run, source_decision = [str(uuid.uuid4()) for _ in range(5)]
    profile = {'companyId': job['companyId'], 'projectId': job['projectId'], 'taskIds': [job['taskId']], 'agentId': job['agentId'],
        'scopeAgentId': lead, 'scopeIssueIds': [job['scopeIssueId']], 'reviewerAgentIds': [reviewer],
        'targetDocumentKey': 'target', 'actualAcpDocumentKey': 'actual-review', 'reviewDocumentKey': 'verdict',
        'candidate': 'f' * 40, 'allowedModes': ['diagnostic_only'],
        'savedSessions': {lead: 'lead-saved', reviewer: 'review-saved', job['agentId']: 'worker-saved'},
        'sourceDecisionFingerprints': {source_decision: {'id': source_decision, 'issue': job['taskId'],
            'stageId': str(uuid.uuid4()), 'outcome': 'approved', 'bodyMd5': 'b' * 32}},
        'sourceAuthority': {'baselineSourceApproval': {'kind': 'issue_execution_decision', 'id': source_decision},
            'sourceLineage': {'contract': {'candidate': 'f' * 40}, 'historicalPacketSha256': 'b' * 64, 'documentationErrataSha256': 'c' * 64}}}
    C = {'wholePacketSha256': job['packetSha256'], 'mode': 'diagnostic_only', 'targetDocumentRevisionId': target,
         'verdictDocumentRevisionId': verdict, 'interactionId': interaction, 'reviewerRunId': review_run,
         'reviewerAgentId': reviewer, 'provider': 'anthropic', 'sessionId': 'review-saved'}
    S = {'wholePacketSha256': job['packetSha256'], 'mode': 'diagnostic_only', 'actualAcpDocumentRevisionId': acp,
         'targetDocumentRevisionId': target, 'verdictDocumentRevisionId': verdict, 'nativeReviewInteractionId': interaction,
         'acceptedSourceLineage': profile['sourceAuthority']['sourceLineage']['contract'], 'decision': 'remaining-closed-diagnostic'}
    scope = {'id': job['scopeCommentId'], 'issueId': job['scopeIssueId'], 'companyId': job['companyId'], 'authorAgentId': lead,
             'createdByRunId': scope_run, 'createdAt': '2026-11-15T12:03:00Z', 'deletedAt': None, 'body': ''}
    A = {'wholePacketSha256': job['packetSha256'], 'mode': 'diagnostic_only', 'candidate': profile['candidate'],
         'continuationId': 'candidate-new', 'attempt': 1, 'maxAttempts': 1, 'phaseOrder': ['diagnostic', 'cleanup'],
         'scopeContractSha256': 'd' * 64, 'recipeManifestSha256': 'd' * 64, 'casePackageSha256': 'd' * 64,
         'continuationScope': {**S, 'kind': 'issue_comment', 'issueId': scope['issueId'], 'commentId': scope['id'], 'authorAgentId': lead},
         'actualAcpReview': {**C, 'documentRevisionId': acp},
         'nativeReview': {'wholePacketSha256': job['packetSha256'], 'targetDocumentRevisionId': target,
            'documentRevisionId': verdict, 'resolvedByRunId': review_run, 'resolvedByAgentId': reviewer},
         'sourceLineageHistoricalEvidence': {k: profile['sourceAuthority']['sourceLineage'][k] for k in ['historicalPacketSha256', 'documentationErrataSha256']},
         'functionalCasesStarted': False, 'featurePassed': False}
    def body(value): return '```json\n' + json.dumps(value) + '\n```'
    scope['body'] = body(S)
    ack = {'id': job['ackCommentId'], 'issueId': job['taskId'], 'companyId': job['companyId'], 'authorAgentId': job['agentId'],
           'createdByRunId': ack_run, 'createdAt': '2026-11-15T12:04:00Z', 'deletedAt': None, 'body': body(A)}
    documents = {'target': {'latestRevisionId': target}, 'verdict': {'latestRevisionId': verdict},
                 'actual-review': {'latestRevisionId': acp, 'updatedByAgentId': lead, 'body': body(C)}}
    review = {'id': interaction, 'status': 'accepted', 'result': {'outcome': 'accepted'}, 'resolvedByRunId': review_run,
              'resolvedByAgentId': reviewer, 'createdByAgentId': job['agentId'], 'effectiveResolverPolicy': 'not_creator',
              'payload': {'target': {'revisionId': target}}}
    issue = {'id': job['taskId'], 'companyId': job['companyId'], 'projectId': job['projectId'], 'assigneeAgentId': job['agentId'], 'status': 'in_progress'}
    runs = []
    for identity, actor, provider, session, time in [(author_run, job['agentId'], 'openai', 'worker-saved', '12:00'),
        (review_run, reviewer, 'anthropic', 'review-saved', '12:02'), (scope_run, lead, 'openai', 'lead-saved', '12:03'),
        (ack_run, job['agentId'], 'openai', 'worker-saved', '12:04'), (job['sourceRunId'], job['agentId'], 'openai', 'worker-saved', '12:05')]:
        runs.append({'kind': 'run', 'id': identity, 'agent': actor, 'provider': provider, 'status': 'succeeded',
                     'before': session, 'after': session, 'actualACP': identity == review_run, 'finished': '2026-11-15T' + time + ':00Z'})
    records = runs + [{'kind': 'decision', **profile['sourceDecisionFingerprints'][source_decision]}]
    gates = {'companyActive': True, 'projectActive': True, 'pauseHeld': False}
    def read(path):
        if path.endswith('/interactions'): return [review]
        if '/documents/' in path: return documents[path.split('/')[-1]]
        if '/agents/' in path: return {'companyId': job['companyId'], 'status': 'idle'}
        return issue
    native = SimpleNamespace(read=read, comment=lambda _issue, ident: scope if ident == scope['id'] else ack,
        metadata=lambda *_: records, admission_gates=lambda *_: gates)
    packet = SimpleNamespace(contract={'mode': 'diagnostic_only', 'remainingScopeDecision': S['decision'], 'phaseOrder': A['phaseOrder']},
        trial={'continuationId': A['continuationId'], 'trialId': 'example'}, directory='qualification-new', case_name='new-cases-v1.tar.gz',
        authority_schema='example-new-verified.v2', file_sha=lambda _: 'd' * 64,
        json=lambda _: {'rows': [{'runId': author_run, 'aiConnection.provider': 'openai'}]})
    return SimpleNamespace(job=job, profile=profile, scope=scope, ack=ack, documents=documents, review=review, issue=issue,
        records=records, gates=gates, service=ReviewAdmissionService(native), packet=packet)


class AdmissionTests(unittest.TestCase):
    def test_typed_current_independent_records_admit_without_changing_native_state(self):
        f = fixture()
        before = copy.deepcopy((f.issue, f.records, f.review))
        result = f.service.controller(f.job, f.profile, f.packet)
        self.assertTrue(result['admission']['approved'])
        self.assertEqual(result['admission']['attempt'], 1)
        self.assertEqual(before, (f.issue, f.records, f.review))

    def test_current_holds_stale_reviews_wrong_provider_or_rotated_session_fail_closed(self):
        changes = [lambda f: f.gates.update(pauseHeld=True), lambda f: f.gates.update(companyActive=False),
            lambda f: f.gates.update(projectActive=False), lambda f: f.issue.update(assigneeAgentId=str(uuid.uuid4())),
            lambda f: f.issue.update(blockedBy=[{'status': 'todo'}]),
            lambda f: f.documents['target'].update(latestRevisionId=str(uuid.uuid4())),
            lambda f: f.documents['actual-review'].update(updatedByAgentId=f.job['agentId']),
            lambda f: f.review.update(effectiveResolverPolicy='creator'),
            lambda f: f.records[1].update(actualACP=False), lambda f: f.records[1].update(provider='openai'),
            lambda f: f.records[1].update(after='new-unexpected-session'),
            lambda f: f.records[1].update(finished='2026-11-15T12:06:00Z'),
            lambda f: f.records[-1].update(bodyMd5='d' * 32), lambda f: f.ack.update(deletedAt='2026-11-15T12:06:00Z')]
        for change in changes:
            f = fixture()
            change(f)
            with self.subTest(change=change), self.assertRaises((Refusal, KeyError)):
                f.service.controller(f.job, f.profile, f.packet)

    def test_chronology_compares_instants_instead_of_iso_lexical_order(self):
        self.assertLess(instant('2026-11-15T14:01:00+02:00'), instant('2026-11-15T12:02:00Z'))
        with self.assertRaises(Refusal): instant('2026-11-15T12:02:00')
