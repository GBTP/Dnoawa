/**
 * 站内信的已读记录。
 *
 * 服务端**不存已读状态**（见 Bnoawa 的 `Models/Notification.cs` 类注释：已读是每台设备
 * 自己的观感，存服务端反而要替「多设备该不该同步」做一个没人要求的决定）。所以只能落本地。
 *
 * 记的是【点开过哪几条】的 id，不是「见过的最大 id」那种水位线。水位线有两个毛病：
 * 打开一次收件箱就把没点开的也算成读过了；而删除是服务端全局的，别的设备删掉几条之后
 * 水位线跟真实列表对不上。客户端 `NotificationReadState.cs` 也是同一个结论。
 *
 * 两份记录刻意分开存，见下面各自的注释。纯 localStorage，不发请求。
 */

import { getProfile } from './api.js';

/**
 * 通知**按身份分开存**。通知 id 大概率是全局自增的，但后端没有明文保证；万一是按用户
 * 各自编号的，共用一份会让切过去的身份凭空少掉几条未读——那是会静默吞掉通知的错误。
 */
const NOTIFICATION_PREFIX = 'anoawa.inbox.read.notifications.';

/**
 * 公告**不按身份分**：公告是全站广播，换个身份不该让它们全变未读。
 *
 * 存的是 `{ id: updatedAtUtc }` 而不是一个 id 集合——**同一条公告被改过就要重新算未读**。
 * 更新日志会一条条往上追加内容，只按 id 记的话第一次点开之后就再也不提示了。
 */
const ANNOUNCEMENT_KEY = 'anoawa.inbox.read.announcements';

/**
 * 每份最多留这么多条。超了丢 id 最小的那些：两个列表都按时间倒序，最小 id 就是最老的一批，
 * 早就翻不到了。真被丢掉也只是重新显示成未读，不会丢数据。
 */
const MAX_ENTRIES = 500;

// ---------- 存取 ----------

function read(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** 隐私模式或配额满时 localStorage 会抛。已读记录丢了只是重新显示未读，不该让整页崩掉。 */
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}

/**
 * 当前身份的 id。登录和切换身份时都会写进本地存档（见 `js/auth.js` 的 login 和
 * user.html 的 switchTo）。拿不到时退回 'unknown'——那样至少同一台设备上仍然自洽，
 * 总好过每次都算全部未读。
 */
function currentProfileId() {
  const id = getProfile().activeProfileId;
  return Number.isInteger(id) ? String(id) : 'unknown';
}

function notificationKey() {
  return NOTIFICATION_PREFIX + currentProfileId();
}

// ---------- 通知 ----------

function readNotificationIds() {
  const list = read(notificationKey(), []);
  return Array.isArray(list) ? list : [];
}

export function isNotificationRead(id) {
  return readNotificationIds().includes(id);
}

/** 点开一条时调。仅仅打开收件箱不算已读——那样没看的也会被一起标掉。 */
export function markNotificationRead(id) {
  const ids = readNotificationIds();
  if (ids.includes(id)) return;

  ids.push(id);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => a - b).splice(0, ids.length - MAX_ENTRIES);
  }
  write(notificationKey(), ids);
}

/** 通知被删掉之后调。那一行永远不会再被问到，留着只是垃圾。 */
export function forgetNotification(id) {
  const ids = readNotificationIds().filter(item => item !== id);
  write(notificationKey(), ids);
}

/** 清空全部通知之后调。 */
export function forgetAllNotifications() {
  try {
    localStorage.removeItem(notificationKey());
  } catch {
    /* 忽略 */
  }
}

// ---------- 公告 ----------

function readAnnouncementMap() {
  const map = read(ANNOUNCEMENT_KEY, {});
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/**
 * 已读的判据是「点开时的 updatedAtUtc 和现在这条一样」。不一样说明公告被编辑过，
 * 重新算未读——更新日志追加了内容就该再提示一次。
 */
export function isAnnouncementRead(item) {
  if (!item) return false;
  return readAnnouncementMap()[String(item.id)] === item.updatedAtUtc;
}

export function markAnnouncementRead(item) {
  if (!item) return;

  const map = readAnnouncementMap();
  map[String(item.id)] = item.updatedAtUtc;

  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => Number(a) - Number(b))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach(id => delete map[id]);
  }
  write(ANNOUNCEMENT_KEY, map);
}

// ---------- 角标 ----------

/**
 * 这两批里有几条没点开过。顶栏角标用它。
 *
 * @param {object[]} notifications
 * @param {object[]} announcements
 */
export function countUnread(notifications = [], announcements = []) {
  const readIds = new Set(readNotificationIds());
  const unreadNotifications = notifications.filter(item => !readIds.has(item.id)).length;
  const unreadAnnouncements = announcements.filter(item => !isAnnouncementRead(item)).length;
  return unreadNotifications + unreadAnnouncements;
}
