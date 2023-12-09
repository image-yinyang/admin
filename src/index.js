import { Buffer } from 'node:buffer';
import { Router, createCors, error, html } from 'itty-router';

function _logWithCfInfo(method, request, ...args) {
	const { city, region, continent, asOrganization } = request.cf;
	return console[method](`[${request.headers.get('x-real-ip')} / ${city}, ${region}, ${continent} / ${asOrganization}]`, ...args);
}

const logWithCfInfo = _logWithCfInfo.bind(null, 'log');
const warnWithCfInfo = _logWithCfInfo.bind(null, 'warn');

const ADMIN_API_HOST = 'https://api.admin.yinyang.computerpho.be';
const IMG_HOST = 'https://images.yinyang.computerpho.be';

async function query(env, request) {
	logWithCfInfo(request, `query name: ${request.params.qName}`);
	if (request.params.qName === 'distinctInputUrls') {
		const { results, success } = await env.DB.prepare('select distinct InputUrl from ByInputUrl;').all();
		if (success) {
			return (
				`<div id="distinctInputUrls-div"><h2>${results.length} distinct input images</h2>` +
				results
					.reverse()
					.map(
						({ InputUrl }, i) =>
							`<form id="distinctInputUrls-form-${i}">` +
							`<button hx-post="${ADMIN_API_HOST}/q/distinctInputUrl" hx-swap="outerHTML" hx-target="#distinctInputUrls-div">` +
							`<input type="hidden" name="InputUrl" value="${InputUrl}" />` +
							`<img src="${InputUrl}" /></button></form>`,
					)
					.join('\n') +
				'</div>'
			);
		}
	}
}

async function distinctInputUrl(env, request) {
	const formData = Object.fromEntries((await request.formData()).entries());
	logWithCfInfo(request, `distinctInputUrl: ${formData.InputUrl}`);

	const { results, success } = await env.DB.prepare('select RequestId from ByInputUrl where InputUrl = ?').bind(formData.InputUrl).all();
	if (!success) {
		warnWithCfInfo(request, 'bad query?!', results);
		return;
	}

	const kvResults = (
		await Promise.allSettled(
			results.reverse().map(async ({ RequestId }) => {
				try {
					return JSON.parse(await env.RequestsKVStore.get(RequestId));
				} catch (e) {
					warnWithCfInfo(request, `Fetch ${RequestId} failed: ${e}`);
					console.error(e);
				}
			}),
		)
	)
		.map(({ value }) => value)
		.filter((e) => !!e);

	return (
		`<img src="${formData.InputUrl}" style="width: 192px;"/><br/><br/>\n` +
		kvResults
			.map(
				({ results: { good, bad } }) =>
					`<div><img style="border: 1px solid black; margin: 0.3em;" src="${IMG_HOST}/${bad.imageBucketId}">` +
					`<img style="border: 1px solid white; margin: 0.3em;" src="${IMG_HOST}/${good.imageBucketId}"></div>`,
			)
			.join('\n')
	);
}

async function checkAuth(env, request) {
	const auth = request.headers.get('Authorization');
	if (!auth || auth.indexOf('Basic ') !== 0) {
		return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
	}

	const authToken = auth.replace('Basic ', '');
	const authStr = Buffer.from(authToken, 'base64').toString();
	const [user, passphrase] = authStr.split(':');

	if (!user.length || !passphrase.length || passphrase !== (await env.BasicAuthKVStore.get(user))) {
		warnWithCfInfo(request, `Bad user "${user}", passphrase "${passphrase}"`);
		return new Response(null, { status: 403 });
	}
}

async function checkAllowedHost(env, origin, request) {
	const allowedHosts = JSON.parse(await env.CommonKVStore.get('allowedHostsJSON'));
	if (!allowedHosts.includes(origin)) {
		warnWithCfInfo(request, `Disallowed origin: ${origin}`);
		return new Response(null, { status: 405 });
	}
}

export default {
	async fetch(request, env) {
		const origin = request.headers.get('origin');
		const { preflight, corsify } = createCors({
			methods: ['GET'],
			origins: [origin],
		});

		const router = Router();

		router
			.all('*', checkAllowedHost.bind(null, env, origin))
			.all('*', preflight)
			.all('*', checkAuth.bind(null, env))
			.get('/q/:qName', query.bind(null, env))
			.post('/q/distinctInputUrl', distinctInputUrl.bind(null, env))
			.all('*', () => error(404));

		return router.handle(request).then(html).catch(error).then(corsify);
	},
};
