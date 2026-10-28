export function t(key: string, ...subs: string[]): string {
  return chrome.i18n.getMessage(key, subs) || key;
}
