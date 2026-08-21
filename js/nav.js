/* 移动端顶栏折叠。
 *
 * 顶栏最多要放 7 个链接，窄屏放不下。app.css 里已经用 flex:none + nowrap 挡住了
 * 「被挤成一字宽、文字竖排」，这里再把导航折成顶栏下方的面板——跟 docs/ 的目录
 * 面板同一套行为，全站移动端导航只有一种形态。
 *
 * 两个刻意的取舍：
 *
 * 1. 折叠样式全挂在 .topbar.nav-collapsed 下面，由这个脚本加类。CSS 不能自己在
 *    max-width:640px 里直接把导航藏了——HTML 是 max-age=600 而 JS 被 Cloudflare
 *    覆盖成 14400，两边有最长 4 小时对不上的窗口。这个脚本没到位时导航必须还能
 *    用，那时它退化成可横向滑动的一行。
 * 2. 链接少于 4 条的页面（login、get）不折。为两个链接放一个汉堡按钮，只是多一
 *    次点击。
 */

const bar = document.querySelector('.topbar');
const nav = bar?.querySelector('.top-actions');

if (nav && nav.children.length >= 4) {
  if (!nav.id) nav.id = 'top-nav';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-controls', nav.id);
  toggle.setAttribute('aria-expanded', 'false');
  nav.insertAdjacentElement('afterend', toggle);
  bar.classList.add('nav-collapsed');

  // 标题单独包一层：下面还要往按钮里塞未读小点，改 textContent 会把它一并抓掉
  const label = document.createElement('span');
  label.textContent = '☰ 菜单';
  toggle.append(label);

  const setOpen = (open) => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    label.textContent = open ? '✕ 菜单' : '☰ 菜单';
  };
  const isOpen = () => nav.classList.contains('open');

  toggle.addEventListener('click', () => setOpen(!isOpen()));

  // 站内信角标跟着导航一起被收起来了，把它的显隐镜到按钮上。角标是页面脚本
  // 拿到未读数之后才去 hidden 的，时机比这里晚，所以盯属性而不是只读一次
  const badge = nav.querySelector('.top-badge');
  if (badge) {
    const dot = document.createElement('span');
    dot.className = 'nav-toggle-dot';
    toggle.append(dot);
    const sync = () => { dot.hidden = badge.hidden; };
    new MutationObserver(sync).observe(badge, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }

  // 点面板外收起。toggle 自己的 click 先跑，所以这里要把它排除掉，否则一开就关
  document.addEventListener('click', (e) => {
    if (isOpen() && !nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  // 转到横屏／放大窗口后导航本来就摊开了，.open 留着会让 aria-expanded 说谎
  matchMedia('(max-width: 640px)').addEventListener('change', (e) => {
    if (!e.matches && isOpen()) setOpen(false);
  });
}
