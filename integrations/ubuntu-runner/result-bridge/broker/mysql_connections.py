"""Durable IDs registered before the privileged client receives any SQL input."""
import hashlib
import pathlib
import uuid
from configuration import private_file
from contracts import canonical, closed_json, require, SHA
from ownership_ledger import OwnershipLedger


class MysqlConnectionRepository:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.ledger = OwnershipLedger(root)

    def register(self, identity, binding, statement):
        require(type(identity) is int and identity > 0, 'managed_mysql_connection_invalid')
        record = {'recordId': str(uuid.uuid4()), 'connectionId': identity, 'mysqlBinding': binding,
                  'statementSha256': hashlib.sha256(statement).hexdigest(), 'registeredBeforeSql': True}
        self.ledger.once('mysql-connection-' + record['recordId'] + '.json', record)
        return record

    def records(self, binding):
        records = []
        for path in self.root.glob('mysql-connection-*.json'):
            value = closed_json(private_file(path).read_bytes())
            require(value['mysqlBinding'] == binding and value.get('registeredBeforeSql') is True and
                    type(value['connectionId']) is int and value['connectionId'] > 0 and
                    SHA.fullmatch(value['statementSha256']), 'managed_mysql_record_changed')
            records.append(value)
        return records

    def complete(self, record, exit_code):
        self.ledger.once('mysql-finished-' + record['recordId'] + '.json', {'recordId': record['recordId'], 'exit': exit_code})
