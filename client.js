window.__ModuleLoader__.load({
  id: 'dsh-agent-llm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /*
     * Providers owned by this bundle. Contributions from other providers are
     * rendered exactly as the host would render them.
     */
    const OWNED = new Set(['workbuddy', 'workbuddy-ai', 'hermes-agent']);

    function freeBadgeText(localeId) {
      return typeof localeId === 'string' && localeId.toLowerCase().startsWith('zh') ? '免费' : 'Free';
    }

    function AgentModelLabel(props) {
      const provider = props.provider;
      const model = props.model;
      const localeId = props.localeId;
      if (!provider || !model || typeof provider.id !== 'string' || !OWNED.has(provider.id)) {
        return h('span', null, model && model.name ? model.name : '');
      }
      const description = typeof model.description === 'string' ? model.description : '';
      let name = typeof model.name === 'string' ? model.name : '';
      const freeSuffix = /\s*·\s*(?:限时免费|免费)$/;
      const isFree = freeSuffix.test(name) || /(^|·\s*)(限时免费|免费)/.test(description);
      if (freeSuffix.test(name)) name = name.replace(freeSuffix, '');
      const children = [
        h(
          'span',
          {
            key: 'name',
            style: {
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          name,
        ),
      ];
      if (isFree) {
        children.push(
          h(
            'span',
            {
              key: 'free',
              style: {
                flex: 'none',
                marginInlineStart: '0.35em',
                padding: '0 0.4em',
                borderRadius: '999px',
                border: '1px solid var(--dsw-alias-state-success-primary)',
                color: 'var(--dsw-alias-state-success-primary)',
                fontSize: '0.82em',
                lineHeight: '1.5',
                fontWeight: 500,
              },
            },
            freeBadgeText(localeId),
          ),
        );
      }
      return h(
        'span',
        {
          title: description.length > 0 ? description : undefined,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            minWidth: 0,
            maxWidth: '100%',
            verticalAlign: 'bottom',
          },
        },
        children,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.model.label', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.model.label',
              id: 'dsh-agent-llm',
              /* The shipped label registers at priority 0; a single slot keeps
                 one occupant per priority and renders the lowest one. */
              priority: -1,
            },
            (props) => {
              let localeId = 'en';
              try {
                const snapshot = ctx.locale.getLocale();
                localeId = snapshot && typeof snapshot.id === 'string' ? snapshot.id : localeId;
              } catch {
                /* Locale is optional for rendering; fall back to English. */
              }
              return h(AgentModelLabel, { ...props, localeId });
            },
          ),
        );
      },
    };
  },
});
