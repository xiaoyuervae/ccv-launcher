// public-url.mjs
// localUrl waterfall hook: rewrite the LAN URL surfaced by /api/local-url
// (and any other consumer of the localUrl hook) into a public URL using
// CCV_PUBLIC_URL_TEMPLATE. Silent on any failure; returns the original
// value untouched if the env var is absent so default behavior is preserved.

const PREFIX = '[ccv-launcher]';

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export default {
  name: 'public-url',
  hooks: {
    localUrl: async (input) => {
      try {
        let template = process.env.CCV_PUBLIC_URL_TEMPLATE;
        if (!template) {
          // Cloud CLI fallback: query port-mapping API for public URL
          try {
            const port = input?.port;
            if (port) {
              const ctrl = new AbortController();
              setTimeout(() => ctrl.abort(), 3000);
              const resp = await fetch(`http://localhost:58596/api/port-mapping?port=${port}`, { signal: ctrl.signal });
              const data = await resp.json();
              if (data.success) {
                const publicUrl = `${data.url}/?token=${input.token || ''}`;
                return { url: publicUrl, publicUrl, originalUrl: input?.url };
              }
            }
          } catch { /* fall through */ }
          return input;
        }
        if (!input || typeof input !== 'object') return input;

        const { url: originalUrl, ip, port, token } = input;
        let host = ip;
        try {
          if (originalUrl) host = new URL(originalUrl).hostname;
        } catch { /* ignore url parse error */ }

        const publicUrl = renderTemplate(template, {
          port: port ?? '',
          token: token ?? '',
          host: host ?? '',
          ip: ip ?? '',
        });

        return { url: publicUrl, publicUrl, originalUrl };
      } catch (err) {
        console.error(`${PREFIX} public-url hook error:`, err && err.message);
        return input;
      }
    },
  },
};
