// Demo credentials for the greenhouse Bots fixture. Not a real account.
// The Bots demo stores them in the member's vault; the Bot never sees them.
window.AcmeDemo = (() => {
  const EMAIL = 'jim@acme.test';
  const PASSWORD = 'Greenhouse-Demo-2026!';
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

  function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of input.replace(/=+$/, '').toUpperCase()) {
      const v = alphabet.indexOf(ch);
      if (v < 0) continue;
      bits += v.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return new Uint8Array(bytes);
  }

  async function totpAt(counter) {
    const key = await crypto.subtle.importKey('raw', base32Decode(TOTP_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, [
      'sign',
    ]);
    const msg = new ArrayBuffer(8);
    new DataView(msg).setUint32(4, counter);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
    const offset = mac[mac.length - 1] & 0x0f;
    const code =
      (((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]) % 1_000_000;
    return String(code).padStart(6, '0');
  }

  return {
    checkPassword(email, password) {
      return email.trim().toLowerCase() === EMAIL && password === PASSWORD;
    },
    async checkTotp(code) {
      const step = Math.floor(Date.now() / 30_000);
      for (const drift of [-1, 0, 1]) if ((await totpAt(step + drift)) === code.trim()) return true;
      return false;
    },
  };
})();
