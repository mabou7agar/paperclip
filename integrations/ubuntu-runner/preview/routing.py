"""Emit only exact local Traefik routes; reuse the prepared gateway."""


def internal_routes(lease, config):
    key = 'paperclip-' + lease['id']
    rule = ' || '.join('Host(`' + host + '`)' for host in lease['private_hosts'].values())
    guard = key + '-guard'
    return {'http': {
        'routers': {key: {'rule': rule, 'entryPoints': [config.get('tls_entrypoint', 'preview-tls')],
                          'middlewares': [guard], 'service': key, 'tls': {}}},
        'middlewares': {guard: {'forwardAuth': {'address': config['guard_address'] + '/authorize/' + lease['id'],
                                               'authRequestHeaders': ['X-Forwarded-Host']}}},
        'services': {key: {'loadBalancer': {'servers': [{'url': 'http://127.0.0.1:' + str(lease['port'])}],
                                           'passHostHeader': True}}}},
        'tls': {'certificates': [lease['certificate']]}}
