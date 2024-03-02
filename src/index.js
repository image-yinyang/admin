import { Buffer } from 'node:buffer';
import { Router, createCors, error, html } from 'itty-router';

function _logWithCfInfo(method, request, ...args) {
	const { city, region, continent, asOrganization } = request.cf;
	return console[method](`[${request.headers.get('x-real-ip')} / ${city}, ${region}, ${continent} / ${asOrganization}]`, ...args);
}

const logWithCfInfo = _logWithCfInfo.bind(null, 'log');
const warnWithCfInfo = _logWithCfInfo.bind(null, 'warn');

const MAIN_HOST = 'https://yinyang.computerpho.be';
const ADMIN_API_HOST = 'https://api.admin.yinyang.computerpho.be';
const IMG_HOST = 'https://images.yinyang.computerpho.be';
const INPUTS_HOST = 'https://inputs.yinyang.computerpho.be';

async function _distinctInputUrls(env) {
	const { results, success } = await env.DB.prepare('select distinct InputUrl from ByInputUrl;').all();
	if (success) {
		return results.reverse();
	}

	return null;
}

async function _countRequests(env) {
	const { results, success } = await env.DB.prepare('select count(distinct RequestId) from ByInputUrl;').all();
	if (success) {
		return results; //Object.values(results)[0];
	}
	return null;
}

async function _allRequests(env) {
	const { results, success } = await env.DB.prepare('select distinct InputUrl, RequestId from ByInputUrl;').all();
	if (success) {
		return results.reverse();
	}

	return null;
}

async function query(env, request) {
	logWithCfInfo(request, `query name: ${request.params.qName}`);
	if (request.params.qName === 'distinctInputUrls') {
		const results = await _distinctInputUrls(env);
		if (results) {
			return (
				`
				<div id="distinctInputUrls">
				<div id="distinctInputUrls-div">
				<h2>${results.length} distinct input images</h2>` +
				results
					.map(
						({ InputUrl }, i) =>
							`<form id="distinctInputUrls-form-${i}">` +
							`<button hx-post="${ADMIN_API_HOST}/q/distinctInputUrl" hx-swap="outerHTML" hx-target="#distinctInputUrls-div">` +
							`<input type="hidden" name="InputUrl" value="${InputUrl}" />` +
							`<img src="${InputUrl}" /></button></form>`,
					)
					.join('\n') +
				'</div></div>'
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
		`<div style="margin: 2em;"><img src="${formData.InputUrl}" style="width: 192px;"/></div>\n` +
		kvResults
			.map(
				({ createdTimeUnixMs, requestId, input: { thresholdMod }, results: { good, bad }, meta: { openai_tokens_used } }) =>
					`<div><div>` +
					`<img style="border: 1px solid black; margin: 0.3em;" src="${IMG_HOST}/${bad.imageBucketId}">` +
					`<img style="border: 1px solid white; margin: 0.3em;" src="${IMG_HOST}/${good.imageBucketId}">` +
					`</div><div style="margin-bottom: 1em;">` +
					(thresholdMod != 0 ? `Threshold modifier: ${thresholdMod}<br/>` : '') +
					`${openai_tokens_used} tokens @ <a href="${MAIN_HOST}/?req=${requestId}" target="_blank">` +
					`${new Date(createdTimeUnixMs).toISOString()}</a>` +
					'<br/>' +
					`Prompt byte lengths: good=${good.prompt.length}, bad=${bad.prompt.length}` +
					'</div>',
			)
			.join('\n')
	);
}

async function findChains(env, request) {
	logWithCfInfo(request, 'findChains');
	const numCurRequests = await _countRequests(env);
	console.log(`numCurRequests=`);
	console.log(numCurRequests);
	const allRequests = await _allRequests(env);
	const reqIdSet = new Set();
	const reqIdMap = {};
	const ourInputs = {};
	let chains = [];
	let urlChains = [];

	if (allRequests) {
		// serialize the KV store lookups
		for (const { InputUrl, RequestId } of allRequests) {
			const req = await JSON.parse(await env.RequestsKVStore.get(RequestId));
			if (!req) {
				console.error(`Request ${RequestId} not found!?`);
				continue;
			}

			// account for all of them in the set, as it is used to check for existence
			reqIdSet.add(RequestId);

			// only records with .originalUrl are usable for chain search
			if (!req?.input?.originalUrl) {
				continue;
			}

			const { input, requestId, results } = req;
			reqIdMap[RequestId] = { input, requestId, results };
		}

		// identify parents
		for (const [RequestId, req] of Object.entries(reqIdMap)) {
			const ogUrl = new URL(req?.input?.originalUrl);
			if (ogUrl.origin === IMG_HOST) {
				const [reqId, type, ext] = ogUrl.pathname.slice(1).split('.');

				if (reqIdSet.has(reqId)) {
					if (req.yinyangParent) {
						console.error(`${req} already has parent?!`, req);
					}

					// wait: just do this in public, when the request is made!!
					req.yinyangParent = { RequestId: reqId, type };
					ourInputs[RequestId] = req;
				}
			}
		}

		// find chains
		function findChain(request, chainList = []) {
			chainList.unshift(request.requestId);

			if (request.yinyangParent) {
				return findChain(reqIdMap[request.yinyangParent.RequestId], chainList);
			}

			return chainList;
		}

		chains = Object.entries(reqIdMap)
			.map(([_, req]) => findChain(req))
			.filter((chain) => chain.length > 0);
		// TODO: need to filter the chains that are just sub-chains of longer ones!

		urlChains = chains.map((chain) => chain.map((reqId) => [reqId, reqIdMap[reqId].input.originalUrl]));
	}

	let htmlOutStr = '';
	for (const chain of urlChains) {
		for (const [reqId, imageUrl] of chain) {
			htmlOutStr += `<a href="${MAIN_HOST}?req=${reqId}"><image width=64 src="${imageUrl}" /></a>`;
		}

		htmlOutStr += '<br/><hr/><br/>';
	}

	console.log('findChains done!');
	return htmlOutStr + '\n<!--\n' + JSON.stringify({ reqIdMap, ourInputs, chains, urlChains }) + '\n-->\n';
}

// unique reqIds with either/or failure:
// select distinct g.RequestId as RequestId, g.Error as GoodError, b.Error as BadError from GenImgResult g inner join GenImgResult b where b.RequestId = g.RequestId and g.Error is not null or b.Error is not null;

const igsCountQueries = {
	'image generations': 'select count(*) as count from GenImgResult;',
	'with a failure': 'select count(distinct RequestId) as count from GenImgResult where Error is not null;',
	'with a "good" failure': "select count(distinct RequestId) as count from GenImgResult where Error is not null and ImageType = 'good';",
	'with a "bad" failure': "select count(distinct RequestId) as count from GenImgResult where Error is not null and ImageType = 'bad';",
};

const igsAvgMinMaxQueries = {
	'all image prompt lengths':
		'select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult;',
	'<span style="color: darkgreen;">successful</span> image prompt lengths':
		'select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where Error is null;',
	'<span style="color: maroon;">failed</span> image prompt lengths':
		'select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where Error is not null;',
	'all "good" image prompt lengths':
		"select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where ImageType = 'good';",
	'<span style="color: darkgreen;">successful</span> "good" image prompt lengths':
		"select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where ImageType = 'good' and Error is null;",
	'<span style="color: maroon;">failed</span> "good" image prompt lengths':
		"select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where ImageType = 'good' and Error is not null;",
	'all "bad" image prompt lengths':
		"select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where ImageType = 'bad';",
	'<span style="color: darkgreen;">successful</span> "bad" image prompt lengths':
		"select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where ImageType = 'bad' and Error is null;",
	'<span style="color: maroon;">failed</span> "bad" image prompt lengths':
		"select avg(length(Prompt)) as Avg, max(length(Prompt)) as Max, min(length(Prompt)) as Min from GenImgResult where ImageType = 'bad' and Error is not null;",
};

async function imageGenStats(env, request) {
	return (
		await Promise.all(
			Object.entries(igsCountQueries).map(async ([qName, query]) => {
				const {
					results: [{ count }],
				} = await env.DB.prepare(query).all();
				return `<div><h4 style="margin-bottom: 0.1em;">Total ${qName}:</h4>${count}</div>`;
			}),
		)
	)
		.concat(
			await Promise.all(
				Object.entries(igsAvgMinMaxQueries).map(async ([qName, query]) => {
					const {
						results: [{ Avg, Min, Max }],
					} = await env.DB.prepare(query).all();
					return `
				<div>
					<h4 style="margin-bottom: 0.1em;">Avg/Min/Max of ${qName}:</h4>
					${Avg} / ${Min} / ${Max}
				</div>
				`;
				}),
			),
		)
		.join('\n');
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

async function uiIndex(request) {
	return `
    <div id="uiIndex">
        <button hx-get="${ADMIN_API_HOST}/q/distinctInputUrls" hx-swap="outerHTML" hx-target="#uiIndex">
            Load distinct input images
        </button>
		<br/>
        <button hx-get="${ADMIN_API_HOST}/findChains" hx-swap="outerHTML" hx-target="#uiIndex">
            Find chains
        </button>
		<br/>
        <button hx-get="${ADMIN_API_HOST}/q/imageGenStats" hx-swap="outerHTML" hx-target="#uiIndex">
            Image generation stats
        </button>
    </div>
	`;
}

export default {
	async fetch(request, env) {
		const origin = request.headers.get('origin');
		const { preflight, corsify } = createCors({
			methods: ['GET', 'POST'],
			origins: [origin],
		});

		const router = Router();

		router
			.all('*', checkAllowedHost.bind(null, env, origin))
			.all('*', preflight)
			.all('*', checkAuth.bind(null, env))
			.get('/ui-index', uiIndex)
			.get('/q/:qName', query.bind(null, env))
			.get('/q/imageGenStats', imageGenStats.bind(null, env))
			.post('/q/distinctInputUrl', distinctInputUrl.bind(null, env))
			.get('/findChains', findChains.bind(null, env))
			.all('*', () => error(404));

		const ourError = (...args) => {
			console.error('Router middleware threw:');
			console.error(...args);
			return error(...args);
		};

		return router.handle(request).then(html).catch(ourError).then(corsify);
	},
};
