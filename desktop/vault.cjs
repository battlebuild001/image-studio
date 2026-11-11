'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 96 * 1024;
const NAMESPACES = new Set(['settings', 'youtube.oauth']);
function safeError(code, message) {const error = new Error(message);error.code = code;return error;}
function createVault({directory, safeStorage, platform = process.platform} = {}) {
  if (!path.isAbsolute(directory || '') || !safeStorage) throw new Error('보안 저장소를 준비하지 못했어요.');
  const filename = path.join(directory, 'secure-settings-v1.bin');
  const status = () => {
    let available = false;
    try {available = safeStorage.isEncryptionAvailable() === true && !(platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');} catch {}
    return {available, ...(available ? {} : {reason: '운영체제 보안 저장소를 사용할 수 없어요. 이 실행 중에만 키를 보관하거나 보안 저장소를 활성화해 주세요.'})};
  };
  function assertAvailable() {if (!status().available) throw safeError('DESKTOP_SECURE_STORAGE_UNAVAILABLE', status().reason);}
  function namespace(name) {if (!NAMESPACES.has(name)) throw safeError('DESKTOP_VAULT_INPUT', '지원하지 않는 보안 설정이에요.');}
  function readAll() {
    if (!fs.existsSync(filename)) return {};
    assertAvailable();
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('invalid');
      const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(envelope.ciphertext)) throw new Error('invalid');
      const result = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !NAMESPACES.has(key))) throw new Error('invalid');
      return result;
    } catch {throw safeError('DESKTOP_VAULT_READ_FAILED', '보안 설정을 읽지 못했어요. 키를 다시 입력하거나 보안 설정을 지운 뒤 저장해 주세요.');}
  }
  function writeAll(value) {
    assertAvailable();
    const plaintext = JSON.stringify(value);
    if (Buffer.byteLength(plaintext) > 64 * 1024) throw safeError('DESKTOP_VAULT_INPUT', '보안 설정이 너무 커요.');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const encrypted = safeStorage.encryptString(plaintext);
    const data = JSON.stringify({version: 1, ciphertext: encrypted.toString('base64')});
    const staged = filename + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    try {
      const fd = fs.openSync(staged, 'wx', 0o600);
      try {fs.writeFileSync(fd, data, 'utf8');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(staged, filename);
    } catch {throw safeError('DESKTOP_VAULT_WRITE_FAILED', '보안 설정을 저장하지 못했어요. 저장 위치와 디스크 공간을 확인해 주세요.');}
    finally {try {fs.unlinkSync(staged);} catch {}}
  }
  function readSync(name) {namespace(name);return structuredClone(readAll()[name] ?? null);}
  function writeSync(name, value) {namespace(name);const all = readAll();all[name] = structuredClone(value);writeAll(all);return true;}
  function deleteSync(name) {
    namespace(name);
    const all = readAll();delete all[name];
    if (!Object.keys(all).length) {try {fs.unlinkSync(filename);} catch (cause) {if (cause.code !== 'ENOENT') throw safeError('DESKTOP_VAULT_WRITE_FAILED', '보안 설정을 지우지 못했어요.');}return true;}
    writeAll(all);return true;
  }
  function resetSync() {
    // Main-process native confirmation owns this recovery operation. Preserve an
    // opaque encrypted copy rather than requiring decryption or deleting data.
    if (!fs.existsSync(filename)) return true;
    const quarantined=filename+'.reset-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex');
    try {fs.renameSync(filename,quarantined);return true;} catch {throw safeError('DESKTOP_VAULT_WRITE_FAILED','보안 설정을 초기화하지 못했어요. 프로그램을 다시 실행한 뒤 시도해 주세요.');}
  }
  return {status, readSync, writeSync, deleteSync, resetSync, read: async name => readSync(name), write: async (name, value) => writeSync(name, value), delete: async name => deleteSync(name)};
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateSettingsPatch(input) {
  if (!plain(input) || Object.keys(input).some(key => !['openai','typecast','server'].includes(key))) throw safeError('DESKTOP_SETTINGS_INPUT','저장할 API 설정을 확인해 주세요.');
  let bytes;try {bytes=Buffer.byteLength(JSON.stringify(input));}catch {throw safeError('DESKTOP_SETTINGS_INPUT','저장할 API 설정을 확인해 주세요.');}
  if (bytes>16*1024) throw safeError('DESKTOP_SETTINGS_INPUT','API 설정이 너무 커요.');
  for (const [provider,value] of Object.entries(input)) {
    if (value === null) continue;
    const fields=provider==='server'?['baseUrl','accessToken']:provider==='openai'?['enabled','apiKey','rememberForTab','rememberInBrowser','scriptModel','imageModel','transcribeModel']:['enabled','apiKey','rememberForTab','rememberInBrowser','model'];
    if (!plain(value)||Object.keys(value).some(key=>!fields.includes(key))) throw safeError('DESKTOP_SETTINGS_INPUT','저장할 API 설정을 확인해 주세요.');
    for (const [key,leaf] of Object.entries(value)) {
      if (['enabled','rememberForTab','rememberInBrowser'].includes(key)) {if(typeof leaf!=='boolean')throw safeError('DESKTOP_SETTINGS_INPUT','키 보관 방식을 확인해 주세요.');}
      else if (typeof leaf!=='string'||leaf.length>(key==='accessToken'?4096:key==='apiKey'?2048:key==='baseUrl'?2048:120)||/[\u0000-\u001f\u007f]/u.test(leaf)) throw safeError('DESKTOP_SETTINGS_INPUT','API 키와 모델 설정을 확인해 주세요.');
    }
    if(value.rememberForTab===true&&value.rememberInBrowser===true)throw safeError('DESKTOP_SETTINGS_INPUT','키 보관 방식은 하나만 선택해 주세요.');
  }
  return structuredClone(input);
}
/** Local synchronous operations keep existing settings UI success/failure atomic. */
function createSettingsStore(vault,{normalizeServerBase=value=>value}={}) {
  let volatile={};
  function load() {const settings=vault.readSync('settings')||{};return {...vault.status(),settings:{...settings,...structuredClone(volatile)}};}
  function save(input) {
    const patch=validateSettingsPatch(input),before=vault.readSync('settings')||{},persistent={...before},nextVolatile={...volatile};
    for(const [provider,value] of Object.entries(patch)) {
      if(provider==='server'&&value!==null)value.baseUrl=normalizeServerBase(value.baseUrl||'');
      delete persistent[provider];delete nextVolatile[provider];
      if(value!==null) {
        if(provider==='server'||value.rememberInBrowser===true)persistent[provider]=value;
        else if(value.rememberForTab===true)nextVolatile[provider]=value;
      }
    }
    // Only touch disk when persistent data changes. Tab-only keys work even
    // when the OS keyring is unavailable and never enter Chromium storage.
    if(JSON.stringify(before)!==JSON.stringify(persistent)) {
      if(Object.keys(persistent).length)vault.writeSync('settings',persistent);else vault.deleteSync('settings');
    }
    volatile=nextVolatile;return{saved:true,...vault.status()};
  }
  function clear() {vault.deleteSync('settings');volatile={};return{cleared:true};}
  return{load,save,clear,clearVolatile:()=>{volatile={};}};
}
module.exports = {createVault,createSettingsStore,validateSettingsPatch};
