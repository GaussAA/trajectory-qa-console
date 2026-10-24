/** 回环地址判断：`qa serve` 的 Host 校验与界面 `?agent=` 的目标限制共用这一份。
 *
 *  两边放在同一处，是因为它们守的是同一条边界：诊断请求只该落在本机。
 *  放在 `lib` 而不是 `cli`，界面（app 层）才能引用，又不违反「下层不 import 上层」。 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 主机名是否为回环。接受带方括号的 IPv6（`[::1]`），大小写不敏感。 */
export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(bare)
}

/** 取出 `Host` 请求头里的主机名（去掉端口）。取不出来返回 null。 */
export function hostnameOfHostHeader(header: string | undefined): string | null {
  if (!header) return null
  try {
    // 借 URL 解析：IPv6 的方括号与端口都由它处理，不必自己切字符串。
    return new URL(`http://${header}`).hostname || null
  } catch {
    return null
  }
}
