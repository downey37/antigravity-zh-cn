/**
 * React 碎片化相邻文本节点翻译器。
 * 处理 JSX 插值或内联标签（<code> / <a>）打断的相邻文本碎片，保持中文语序自然。
 */
function translateSplitTextNode(node, val, parent) {
  if (!parent || !val) return null;
  const parentText = parent.textContent || '';

  // 1. 计划模式斜杠指令提示：<span>Type <code>/</code> and select <code>plan</code> to have the agent generate a plan.</span>
  const typeMatch = val.match(/^(\s*)(?:Type|类型)(\s+)$/);
  if (typeMatch) {
    const nextEl = node.nextSibling;
    const isPlanSlashHint =
      parentText.includes('and select') ||
      parentText.includes('并选择') ||
      (nextEl && nextEl.nodeName === 'CODE' && (nextEl.textContent || '').trim() === '/');
    if (isPlanSlashHint) {
      return `${typeMatch[1]}输入${typeMatch[2]}`;
    }
  }

  // 2. 数字 + projects 拆分节点：{a.length} projects
  const projectsMatch = val.match(/^(\s*)projects?(\s*)$/i);
  if (projectsMatch && node.previousSibling && /^\d+$/.test((node.previousSibling.textContent || '').trim())) {
    return `${projectsMatch[1] || ' '}个项目${projectsMatch[2]}`;
  }

  // 3. 数字 + selected 拆分节点：{C.length} selected
  const selectedMatch = val.match(/^(\s*)selected(\s*)$/i);
  if (selectedMatch && node.previousSibling && /^\d+$/.test((node.previousSibling.textContent || '').trim())) {
    return `${selectedMatch[1] || ' '}项已选${selectedMatch[2]}`;
  }

  // 4. Token 统计拆分后缀：({u.tokens.toLocaleString()} tokens)
  const tokensEndMatch = val.match(/^(\s*)tokens?\)(\s*)$/i);
  if (tokensEndMatch && parentText.includes('(')) {
    return ` 个 Token)${tokensEndMatch[2]}`;
  }

  // 5. 终端 PID 前缀：pid {a.pid}
  const pidMatch = val.match(/^(\s*)pid(\s+)$/i);
  if (pidMatch && node.nextSibling && /^\d+$/.test((node.nextSibling.textContent || '').trim())) {
    return `${pidMatch[1]}PID${pidMatch[2]}`;
  }

  // 6. 账户登录引导："Open " + productName + " panel"
  const openMatch = val.match(/^(\s*)Open(\s+)$/i);
  if (openMatch && node.nextSibling && node.nextSibling.nextSibling && /^\s*(?:panel|面板)\s*$/i.test(node.nextSibling.nextSibling.textContent || '')) {
    return `${openMatch[1]}打开${openMatch[2]}`;
  }
  const panelMatch = val.match(/^(\s*)panel(\s*)$/i);
  if (panelMatch && (parentText.trimStart().startsWith('Open ') || parentText.includes('打开 '))) {
    return `${panelMatch[1]}面板${panelMatch[2]}`;
  }

  // 7. 开发者模式运行参数拆分节点
  if (val === 'Current parameter: ') return '当前参数：';
  if (val === '. Active workspace URI: ') return '。当前工作区 URI：';
  if (val === ' (still loading\u2026)' || val === ' (still loading...)') return '（仍在加载…）';

  // 8. 模型配额剩余百分比拆分节点：{f} + "% left"
  if (/^\s*%\s*left\s*$/i.test(val) && node.previousSibling && /^\d+(?:\.\d+)?$/.test((node.previousSibling.textContent || '').trim())) {
    return '% 剩余';
  }

  // 9. "+ 添加上下文" 菜单中的 Browser 保持为“浏览器”，避免套用设置侧栏的“浏览器设置”
  const browserMatch = val.match(/^(\s*)(?:Browser|浏览器设置)(\s*)$/);
  if (browserMatch && parent.closest) {
    const menuEl = parent.closest('[role="menu"], [data-base-ui-portal]');
    const menuText = menuEl ? (menuEl.textContent || '') : '';
    if (menuEl && /Add Context|添加上下文|Actions|操作|Mentions|云端硬盘|Drive/.test(menuText)) {
      return `${browserMatch[1]}浏览器${browserMatch[2]}`;
    }
  }

  // 10. 设置页中文句末孤立英文句号（如 <a>文档指南</a>. / （仍在加载…）.）
  if (
    val === '.' &&
    !node.nextSibling &&
    node.previousSibling &&
    (/[。：]/.test(parentText) || (node.previousSibling.nodeType === 1 && /[\u4e00-\u9fff]/.test(parentText)))
  ) {
    return '。';
  }

  // 11. Diff 统计悬停提示拆分节点：{g} + " insertion" + "s" + " (+)" / {h} + " deletion" + "s" + " (-)"
  if (val === ' insertion' || val === ' insertions') return ' 行新增';
  if (val === ' deletion' || val === ' deletions') return ' 行删除';
  if (
    (val === 's' || val === '') &&
    node.previousSibling &&
    /行新增|行删除|\binsertions?\b|\bdeletions?\b/i.test(node.previousSibling.nodeValue || node.previousSibling.textContent || '')
  ) {
    return '';
  }

  // 12. 网页搜索域名过滤提示拆分节点
  if (val === 'Web search prioritized results from ') return '网页搜索优先展示了来自 ';
  if (val === '. The LLM decided that this would yield the best results. If this is not desired, you can simply tell the agent to search without a domain filter.') {
    return ' 的结果。大模型认为这样能获得最佳结果；如果不希望如此，您可以直接要求智能体在搜索时不使用域名过滤。';
  }

  // 13. 智能体 / 插件 / 工作目录前缀拆分节点
  if (val === 'Agent: ') return '智能体：';
  if (val === 'Plugin: ') return '插件：';
  if (val === 'Working directory: ' || val === 'Working Directory: ') return '工作目录：';
  if (val === '. Change it in the model menu.') return '。可在模型菜单中切换。';

  // 14. 不受信任 Sidecar 警告拆分节点
  if (val === ' See' && /sidecar|伴侣进程|后台服务/i.test(parentText)) return ' 请参阅';

  // 15. 会话悬停卡片装饰器展开按钮："Show submitted (" + k + ")" / "Show more (" + l + ")"
  if (
    val === 'Show submitted (' &&
    node.nextSibling &&
    /^\d+$/.test((node.nextSibling.textContent || '').trim())
  ) {
    return '显示已提交 (';
  }
  if (
    val === 'Show more (' &&
    node.nextSibling &&
    /^\d+$/.test((node.nextSibling.textContent || '').trim())
  ) {
    return '显示更多 (';
  }

  // 16. 云端资源连接弹窗拆分节点："Add " + provider + " resources" / "Connect your account to browse " + provider + "."
  if (val === 'Add ' && node.nextSibling && node.nextSibling.nextSibling && /^(?: resources| 资源)$/.test(node.nextSibling.nextSibling.textContent || '')) {
    return '添加 ';
  }
  if (val === ' resources' && (parentText.startsWith('Add ') || parentText.startsWith('添加 '))) {
    return ' 资源';
  }
  if (val === 'Connect your account to browse ') {
    return '连接您的账号以浏览 ';
  }
  if (val === '.' && !node.nextSibling && /连接您的账号以浏览|Connect your account to browse/.test(parentText)) {
    return '。';
  }

  // 17. 插件目录空状态拆分："There are currently no Build with " + category + " plugins available."
  if (val === 'There are currently no Build with ') {
    return '当前暂无「Build with ';
  }
  if (
    val === ' plugins available.' &&
    (parentText.includes('There are currently no Build with') || parentText.includes('当前暂无「Build with'))
  ) {
    return '」相关可用插件。';
  }

  // 18. 终端/代码块上方隐藏行拆分："(" + n + " " + "line(s)" + " above hidden)"
  if ((val === 'line' || val === 'lines' || val === '行') && node.nextSibling && /above hidden|上方内容已隐藏/i.test(node.nextSibling.textContent || '')) {
    return '行';
  }
  if (/^\s*above hidden\)?\s*$/i.test(val) && node.previousSibling) {
    return val.includes(')') ? '上方内容已隐藏)' : '上方内容已隐藏';
  }

  return null;
}

if (typeof module !== 'undefined') {
  module.exports = { translateSplitTextNode };
}
