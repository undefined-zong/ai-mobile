/**
 * 经云端 Hub 转发（POST /v1/relay）：不让浏览器直连的服务（没有 CORS 头，例如 Fish Audio）由 App 发给 Hub、Hub 再发过去。
 * 目标地址、方法、请求头放在这几个请求头里（请求头的值是 encodeURIComponent 过的 JSON），请求体原样就是要转发的请求体。
 */
export const RELAY_HEADERS = { url: 'X-Relay-Url', method: 'X-Relay-Method', headers: 'X-Relay-Headers' } as const;
/** Hub 的回应带这个头 = 目标服务的原样回应；没有就是 Hub 自己报的错（JSON 的 error） */
export const RELAY_MARK = 'X-Relay';
