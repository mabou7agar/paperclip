"""Validate command DTOs against root-owned registrations, never caller claims."""
import re
import uuid
from dataclasses import dataclass
from pathlib import Path


def identity(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Expected a canonical Paperclip identity.')
    return value


def lease_key(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
        raise ValueError('Expected a preview lease identity.')
    return value


@dataclass(frozen=True)
class AcquireRequest:
    key: str
    project_id: str
    company_id: str
    workspace: str
    aliases: tuple

    @classmethod
    def parse(cls, data, uid, config):
        if not isinstance(data, dict) or set(data) != {'id', 'projectId', 'workspace', 'aliases'}:
            raise ValueError('Invalid acquire fields.')
        principal = config['principals'].get(str(uid))
        project_id = identity(data['projectId'])
        project = config['projects'].get(project_id)
        if not principal or not project or project['company_id'] != principal['company_id']:
            raise ValueError('Project is not registered for this runner principal.')
        company_id = identity(principal['company_id'])
        workspace = Path(data['workspace']).resolve(strict=True)
        if not workspace.is_dir() or workspace.stat().st_uid != uid:
            raise ValueError('The workspace must be owned by the caller.')
        roots = [Path(p).resolve(strict=True) for p in principal['workspace_roots']]
        if not any(workspace.is_relative_to(root) for root in roots):
            raise ValueError('Workspace is outside the registered roots.')
        aliases = data['aliases']
        if not isinstance(aliases, list) or len(aliases) > 10 or any(
            not isinstance(x, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,20}', x) or x == 'app' for x in aliases
        ) or len(set(aliases)) != len(aliases):
            raise ValueError('Expected unique service or tenant labels.')
        return cls(lease_key(data['id']), project_id, company_id, str(workspace), tuple(aliases))
