"""Combine immutable driver facts with independent setup ownership completion.

A live cleanup supervisor holds delivery, not a provider process. Independent
cleanup can settle ownership but cannot invent application/feature acceptance.
"""
import hashlib
import pathlib
from configuration import private_file
from contracts import closed_json, require, Refusal
from ownership_ledger import process_identity


def settle(root, plan, outcome):
    if not plan['profile'].get('setupContainment'):
        return outcome
    root = pathlib.Path(root)
    if not (root / 'ownership-lease.json').exists():
        # Admission/setup refusal before creating a lease cannot have launched
        # the controller. Keep its definite non-execution result unchanged.
        return outcome
    final_path = root / 'ownership-final.json'
    if not final_path.exists():
        try:
            startup = closed_json(private_file(root / 'ownership-startup.json').read_bytes())
            if process_identity(startup['supervisorPid']) == startup['supervisorStartTicks']:
                return None
        except (FileNotFoundError, ProcessLookupError, Refusal):
            pass
        return {**outcome, 'status': 'unknown', 'cleanupComplete': False,
                'code': 'independent_setup_supervisor_unavailable'}
    raw = private_file(final_path).read_bytes();final = closed_json(raw)
    require(final['jobId'] == plan['jobId'] and final.get('executionRepeated') is False,
            'setup_final_identity_mismatch')
    result = {**outcome, 'supervisorReceiptSha256': hashlib.sha256(raw).hexdigest()}
    if final.get('cleanupComplete') is not True:
        return {**result, 'status': 'unknown', 'cleanupComplete': False,
                'code': 'independent_setup_cleanup_unconfirmed'}
    result['cleanupComplete'] = True
    if outcome.get('status') == 'unknown':
        result.update(status='failed', code='controller_terminated_with_owned_cleanup')
    result['auditComplete'] = outcome.get('auditComplete') is True or final.get('auditComplete') is True
    if not result['auditComplete']:
        result['status'] = 'failed'
    return result
