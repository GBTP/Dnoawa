/**
 * 站内信：个人通知 + 全站公告。
 *
 * 后端把这两样分成两张表（见 Bnoawa 的 `Models/Notification.cs` 类注释）：公告是广播，
 * 一条就是一行、不按人扇出，所以用户侧只读、删不掉；通知是发给某一个身份的，可以删。
 * 这里也就分成两组接口，不合并成一个混合列表。
 *
 * **已读状态服务端不存**，落在本地，见 `inbox-read.js`。
 *
 * 文案与客户端 `Localization~/zh-CN.json` 的 inbox.* 对齐——同一条通知在游戏里和网页上
 * 应该是同一句话。唯一改写的是挂名邀请的正文，见 DETAIL 那里的注释。
 */

import { get, del } from './api.js';
import { countUnread } from './inbox-read.js';

/** 与客户端 InboxPanel.PageSize / MainMenuPage.InboxBadgePageSize 一致。 */
export const PAGE_SIZE = 20;

/** 后端 NotificationTypes 里的四种。 */
export const TYPES = {
  collabInvite: 'LevelCollaboratorInvite',
  collabAccepted: 'LevelCollaboratorAccepted',
  reviewRejected: 'LevelReviewRejected',
  levelRemoved: 'LevelRemovedByAdmin',
};

// ---------- 接口 ----------

/**
 * 我的通知。分页包装，空时是 { items: [], totalCount: 0, ... }。
 *
 * 没有「按 id 取单条」的端点，后端刻意如此（免得再来一个传任意 id 就能读别人东西的接口），
 * 所以详情只能用列表里已经拿到的那条。
 *
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function listNotifications({ page = 1, pageSize = PAGE_SIZE } = {}) {
  return get(`/api/notifications?page=${page}&pageSize=${pageSize}`);
}

/** 删除我的一条通知。服务端删除，所有设备上都会消失。 */
export function deleteNotification(id) {
  return del(`/api/notifications/${id}`);
}

/** 清空我的全部通知。 */
export function clearNotifications() {
  return del('/api/notifications');
}

/**
 * 全站公告。只读——公告不按人扇出，没有「你的那一份」可删。
 *
 * 端点带 [Authorize]，网页没有客户端那种 app token，所以收件箱整个都要求登录。
 *
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function listAnnouncements({ page = 1, pageSize = PAGE_SIZE } = {}) {
  return get(`/api/announcements?page=${page}&pageSize=${pageSize}`);
}

// ---------- 文案 ----------

const TYPE_LABELS = {
  [TYPES.collabInvite]: '挂名邀请',
  [TYPES.collabAccepted]: '挂名已接受',
  [TYPES.reviewRejected]: '审核未通过',
  [TYPES.levelRemoved]: '谱面已被移除',
};

const KIND_LABELS = {
  Changelog: '更新日志',
  Notice: '公告',
  Maintenance: '维护',
};

export function typeLabel(type) {
  return TYPE_LABELS[type] || '通知';
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '公告';
}

/** 载荷里的字符串字段。缺字段和 null 都退化成 fallback。 */
function field(payload, key, fallback = '未命名') {
  const value = payload?.[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

/**
 * 一行摘要。
 *
 * 一律读载荷里冗余的 levelName / 昵称，**不要拿 levelId 反查**——谱面日后被删掉时
 * 这条通知仍然要读得通（「某某邀请你参与《某曲》」），而不是变成一行查不到内容的空记录。
 * 后端就是为此才把展示字段冗余进 PayloadJson 的。
 */
export function summary(item) {
  const payload = item.payload;
  const level = field(payload, 'levelName');

  switch (item.type) {
    case TYPES.collabInvite:
      return `${field(payload, 'inviterNickname', '未知用户')} 邀请你在《${level}》上挂名`;
    case TYPES.collabAccepted:
      return `${field(payload, 'collaboratorNickname', '未知用户')} 接受了《${level}》的挂名邀请`;
    case TYPES.reviewRejected:
      return `《${level}》未通过审核，已被删除`;
    case TYPES.levelRemoved:
      return `《${level}》已被管理员移除`;
    default:
      return item.type || '';
  }
}

/**
 * 展开后的正文。
 *
 * 挂名邀请这条**和客户端的措辞不同**：游戏里接受/拒绝在谱面详情页，网页上在
 * 「我的空间」的待确认挂名邀请里（user.html 的 loadPendingCollaborations）。
 * 照抄客户端会把人指到一个网页上并不存在的入口。
 */
export function detail(item) {
  const payload = item.payload;
  const level = field(payload, 'levelName');
  const role = field(payload, 'role', '合作者');

  switch (item.type) {
    case TYPES.collabInvite:
      return `${field(payload, 'inviterNickname', '未知用户')} 邀请你在《${level}》上挂名，身份是 ${role}。\n\n`
        + '接受或拒绝要到「我的空间」的待确认挂名邀请里操作——删掉这条通知不等于拒绝邀请。';
    case TYPES.collabAccepted:
      return `${field(payload, 'collaboratorNickname', '未知用户')} 接受了《${level}》的挂名邀请，身份是 ${role}。`;
    case TYPES.reviewRejected:
      return `《${level}》的基础信息未通过审核，谱面已被删除。\n\n`
        + '审的是曲名、曲师、谱师、曲绘作者、难度标注、简介、标签这些，不是谱面内容。';
    case TYPES.levelRemoved:
      return `《${level}》已被管理员移除。\n\n理由：${field(payload, 'reason', '未填写')}`;
    default:
      // 认不出的类型（客户端比网页新的时候会有）至少把载荷原样摆出来，别显示成空白
      return payload ? JSON.stringify(payload, null, 2) : '';
  }
}

/**
 * 这条通知点过去该去哪，没有就返回 null。
 *
 * 审核未通过和被管理员移除的谱面**已经不存在了**，跳过去只会是一个 404——
 * 客户端 InboxPanel.ShowDetail 也是这么判的。
 */
export function actionFor(item) {
  const levelId = Number(item.payload?.levelId);
  if (!Number.isInteger(levelId) || levelId <= 0) return null;

  switch (item.type) {
    case TYPES.collabInvite:
      return { href: 'user.html', label: '去处理邀请' };
    case TYPES.collabAccepted:
      return { href: `level.html?id=${levelId}`, label: '打开谱面' };
    default:
      return null;
  }
}

// ---------- 顶栏角标 ----------

/**
 * 刷新顶栏的未读角标。谱面库和我的空间两页各调一次。
 *
 * 这是本模块唯一碰 DOM 的地方：两页要算出一模一样的数字，各写一遍迟早漂开。
 *
 * **只看两个列表的第一页**（和客户端 MainMenuPage.RefreshInboxBadge 一致）：未读超过一页时
 * 会少报，但那种情况下「有很多没读」这个信息本身已经传达到了，为一个角标把整个列表翻完
 * 不划算。已知的另一个缺口是被编辑过的老公告——它的 CreatedAtUtc 没变，可能已经不在第一页，
 * 角标算不到，要翻到那一页才看得见未读。
 *
 * 失败就不显示：离线时顶栏挂个角标反而是误导。
 *
 * @param {?HTMLElement} badge
 */
export async function refreshInboxBadge(badge) {
  if (!badge) return;

  try {
    const [notifications, announcements] = await Promise.all([
      listNotifications({ page: 1, pageSize: PAGE_SIZE }),
      listAnnouncements({ page: 1, pageSize: PAGE_SIZE }),
    ]);

    const unread = countUnread(notifications?.items ?? [], announcements?.items ?? []);
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
  } catch {
    badge.hidden = true;
  }
}
