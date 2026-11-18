import type { Env } from './env.ts';

/** OAuth 品牌资料用的公开说明页，不读取数据库或登录信息。 */
export function publicPage(path: string, env: Env): Response | null {
  const app = env.APP_URL.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const pages: Record<string, { title: string; body: string }> = {
    '/about': {
      title: 'AI 陪伴',
      body: `<p class="lead">个人 AI 陪伴与生活计划工具。</p>
        <p>AI 陪伴支持角色聊天、家务与健康计划，以及结合邮件和日历安排每天的生活。应用由使用者自行配置和部署，云端任务在使用者自己的 Cloudflare Worker 中运行。</p>
        <h2>连接 Google</h2><p>连接 Gmail 后，生活计划可以搜索邮件、读取相关邮件与草稿、识别待办和截止时间。Gmail 连接只读，不发送或修改邮件。Google 日历连接可以读取日历列表与活动，也支持新增、修改和删除活动；日程系统只使用您启用的工具。</p>
        <p>启用平行时空的 Google 日历同步后，您记下的事项会写入主日历，之后修改或删除事项时，对应活动也会更新或删除。这项同步只修改应用为这些事项创建的活动。</p>
        <p>Google 连接是可选功能，Gmail 和日历可以分别开关。您可以在日程系统中选择工具，在平行时空中设置日历同步，也可以随时撤销 Google 授权。</p>
        <p><a class="action" href="${app}">打开 AI 陪伴</a></p>
        <p><a href="/privacy">隐私政策</a> · <a href="/terms">使用条款</a> · <a href="https://github.com/undefined-zong/ai-mobile">项目源码</a></p>`,
    },
    '/privacy': {
      title: 'AI 陪伴 · 隐私政策',
      body: `<p class="lead">本页说明此自托管应用如何处理您的数据。更新日期：2026-11-17。</p>
        <h2>访问哪些 Google 数据</h2><p>Gmail 连接请求 gmail.readonly 权限，用于搜索邮件会话、读取邮件正文和草稿、列出标签。日历连接请求 calendar.events 和 calendar.calendarlist.readonly 权限，用于读取日历列表以及读取、新增、修改和删除活动。您可以分别启用或关闭这两种连接，并选择日程系统可使用的工具。平行时空的日历同步会将事项的标题、时间、备注和清单写入主日历，并更新或删除对应活动。</p>
        <h2>用途与数据流向</h2><p>这些数据用于生成您可见的每日与每周计划、邮件摘要、待办和日程安排，以及将您在平行时空记下的事项同步到 Google 日历。Google API 调用在您的设备或您配置的 Cloudflare Worker 中执行；排计划时，相关查询结果会发送给您配置的“日程计划”模型服务，平行时空的“AI 记一件事”会把已有日程作为安排时间的参考发送给“平行时空”模型服务。如果开启“写进聊天”等上下文选项，生成的计划和安排也会进入聊天、通话或主动消息的模型上下文。模型服务商由您选择，其数据处理受对应服务的条款和配置约束。</p>
        <p>应用没有广告投放、数据出售或训练通用 AI 模型的功能。Google 数据仅用于上述用户可见功能。AI 陪伴对 Google API 数据的使用和传输遵循 <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>，包括 Limited Use 要求。</p>
        <h2>存储与保留</h2><p>应用设置、计划及聊天记录保存在您的设备。通过云端授权的 OAuth Token 与 Client Secret 加密保存在您自己的 Cloudflare D1 数据库中，由 Worker 使用；在本机授权的凭据保存在本机。应用不会把这些凭据写入公开代码仓库。</p>
        <p>连接 Worker 且开启多设备同步后，聊天、计划、角色、记忆及可同步的设置等也会保存在云端，并同步到连接同一 Worker 的其他设备；图片、语音和模型等文件存放在 D1 或所配置的 R2 中。多设备同步不复制本机密钥表中的 API Key、Cookie 或 OAuth 凭据；供云端任务使用的凭据通过单独的配置上传并加密保存。</p>
        <p>云端日程任务保存生成结果、调用参数和执行状态，不把整个邮箱复制成云端档案。任务记录保留约 14 天；这不包括多设备同步保存的计划、聊天和其他记录，也不包括设备上的副本，这些数据会保留至您删除。计划结果可能含邮件摘要等个人信息。导出的整机备份保存本机数据，选择包含密钥时也包含本机凭据；备份文件由您保存和删除。</p>
        <h2>停止访问与删除</h2><p>在“我的 → 我的人设 → 日程系统”关闭日程系统可以停止自动排计划，关闭对应服务器连接可以停止日程系统使用该连接。在平行时空设置中关闭“新记的事同步到 Google 日历”后，不再自动同步新事项；已经关联的事项在修改或删除时仍会更新对应日历活动。删除服务器连接会删除本机凭据，云端对应凭据在下次同步时删除。您也可以在 <a href="https://myaccount.google.com/connections">Google 账号的第三方连接</a>中撤销授权，以停止该授权的后续访问。</p>
        <p>撤销 Google 授权不会自动删除已有计划或已写入的日历活动。应用内删除的可同步记录会在同步后传到其他设备；仅清除本机存储或关闭多设备同步不会清空云端副本。已有日历活动可在 Google 日历中管理和删除。云端数据库、R2 文件及备份由此部署的所有者在自己的账号和设备中管理和删除。</p>
        <h2>联系</h2><p>本部署由其使用者自行管理。涉及此 OAuth 应用的支持请求，可通过 Google 授权页面显示的用户支持邮箱联系部署所有者。通用程序问题可通过 <a href="https://github.com/undefined-zong/ai-mobile/issues">项目问题页</a>反馈；请勿在公开反馈中附上邮件、日历内容或密钥。</p>`,
    },
    '/terms': {
      title: 'AI 陪伴 · 使用条款',
      body: `<p class="lead">适用于本个人自托管部署。更新日期：2026-11-17。</p>
        <h2>服务范围</h2><p>AI 陪伴提供 AI 聊天、个人生活计划和平行时空日程记录功能。使用者自行选择模型服务、部署云端组件并连接自己的账号。Google 连接是可选功能；Gmail 只读，不发送或修改邮件。Google 日历在您授权并启用相应工具或同步功能后，可以读取、新增、修改和删除活动。</p>
        <h2>账号和授权</h2><p>使用者管理自己的 Google 授权、Cloudflare 部署和模型服务凭据。只应连接本人有权使用的账号。授权可以随时在应用设置或 Google 账号中停止；停止授权与删除已保存数据的方式见<a href="/privacy">隐私政策</a>。</p>
        <h2>生成结果</h2><p>AI 生成的计划、摘要和待办可能遗漏或误解信息。邮件正文、Google 日历中的活动及其实际截止时间是原始记录；请在据此行动时核对原始记录。应用不保证第三方服务持续可用，也不保证生成结果准确。</p>
        <h2>第三方服务</h2><p>Google、Cloudflare 和您选用的模型服务各自适用其服务条款与费用规则。此应用不会代您购买这些服务。您可以停止使用本部署，并在自己的设备和云端账号中管理或删除数据。</p>
        <h2>项目与支持</h2><p>源码和项目说明见 <a href="https://github.com/undefined-zong/ai-mobile">ai-mobile 仓库</a>。此 OAuth 部署的支持联系人以 Google 授权页面显示的用户支持邮箱为准。</p>`,
    },
  };
  const page = pages[path];
  if (!page) return null;
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title}</title><style>
    :root{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;color:#24242b;background:#faf9f6;line-height:1.8}body{margin:0}main{max-width:760px;margin:0 auto;padding:48px 24px 72px}nav{display:flex;gap:20px;flex-wrap:wrap;font-size:14px;border-bottom:1px solid #dedbd3;padding-bottom:18px}a{color:#4e526e;text-underline-offset:4px}h1{font-size:36px;line-height:1.3;margin-top:44px}h2{font-size:21px;margin-top:32px}.lead{color:#65656c;font-size:18px}.action{display:inline-block;background:#4e526e;color:white;padding:10px 20px;border-radius:8px;text-decoration:none}footer{border-top:1px solid #dedbd3;margin-top:40px;padding-top:18px;color:#65656c;font-size:14px}
    </style></head><body><main><nav><a href="/about">AI 陪伴</a><a href="/privacy">隐私政策</a><a href="/terms">使用条款</a></nav><h1>${page.title}</h1>${page.body}<footer>AI 陪伴 · 个人自托管应用</footer></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
