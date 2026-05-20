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
        const template = process.env.CCV_PUBLIC_URL_TEMPLATE;
        if (!template) return input;
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
