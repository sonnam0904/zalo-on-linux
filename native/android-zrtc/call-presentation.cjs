'use strict';
// Display-only data. Never use a contact name for signaling identity, lookup,
// process arguments, markup, file paths or authentication.
function peerName(value) {
  if(typeof value!=='string' || value.length>512)return '';
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ')
    .replace(/\s+/gu,' ').trim()).slice(0,80).join('');
}
// Avatar URLs are display-only and travel only over the isolated local UI pipe.
// Restrict them to Zalo/ZDN HTTPS CDNs; never accept file/data URLs, credentials
// or arbitrary remote hosts supplied through signaling.
function peerAvatar(value) {
  if(typeof value!=='string' || value.length>2048)return '';
  try {
    const url=new URL(value);
    const host=url.hostname.toLowerCase();
    if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') ||
      !['zdn.vn','zadn.vn','zalo.me'].some(domain=>host===domain || host.endsWith('.'+domain)))return '';
    url.hash='';return url.href;
  } catch {return '';}
}
module.exports={peerName,peerAvatar};
