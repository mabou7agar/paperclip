"""Private project origins from a trusted Paperclip company/project registry."""
import re
import string


class DomainPolicy:
    def __init__(self, config):
        self.reserved = config.get('reserved_namespaces', [])
        if not isinstance(self.reserved, list) or len(self.reserved) > 100:
            raise ValueError('Expected a bounded reserved namespace list.')
        for name in self.reserved:
            self.root(name)
        self.template = config.get('domain_template', '{project}-agent.test')
        fields = []
        for _, field, spec, conversion in string.Formatter().parse(self.template):
            if field is not None:
                if field != 'project' or spec or conversion:
                    raise ValueError('Only the project domain placeholder is supported.')
                fields.append(field)
        if fields != ['project']:
            raise ValueError('The template needs exactly one project placeholder.')
        self.root(self.template.format(project='example'))
        labels = set()
        for project in config['projects'].values():
            label = self.label(project['label'])
            if label in labels:
                raise ValueError('Project labels must be unique on this runner.')
            labels.add(label)
            self.root(self.template.format(project=label))
            if type(project.get('concurrent', False)) is not bool:
                raise ValueError('Concurrent previews must be boolean.')

    @staticmethod
    def label(value):
        if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', value):
            raise ValueError('Expected a lowercase DNS label.')
        return value

    @classmethod
    def hostname(cls, value):
        if not isinstance(value, str) or len(value) > 253 or not value.endswith('.test'):
            raise ValueError('Only private .test domains are supported.')
        for label in value.split('.'):
            cls.label(label)
        return value

    @classmethod
    def root(cls, value):
        cls.hostname(value)
        if len(value.split('.')) != 2:
            raise ValueError('Each project requires its own root directly under .test.')
        return value

    def namespace(self, project):
        root = self.root(self.template.format(project=project['label']))
        if root in self.reserved:
            raise ValueError('That namespace belongs to an existing integration.')
        return root

    def hosts(self, project, key, aliases):
        root = self.namespace(project)
        if project.get('concurrent', False):
            root = 'r' + key + '.' + root
        return {name: self.hostname(root if name == 'app' else name + '.' + root) for name in ['app', *aliases]}
