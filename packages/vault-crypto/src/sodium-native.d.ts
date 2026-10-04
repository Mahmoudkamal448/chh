// Minimal typings for the sodium-native functions we use.
declare module 'sodium-native' {
  const sodium: {
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    crypto_kdf_KEYBYTES: number;
    crypto_kdf_CONTEXTBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      c: Buffer, m: Buffer, ad: Buffer | null, nsec: null, npub: Buffer, k: Buffer,
    ): number;
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      m: Buffer, nsec: null, c: Buffer, ad: Buffer | null, npub: Buffer, k: Buffer,
    ): number;
    crypto_kdf_derive_from_key(subkey: Buffer, subkeyId: number, ctx: Buffer, key: Buffer): void;
    randombytes_buf(buf: Buffer): void;
    sodium_memzero(buf: Buffer): void;
    crypto_pwhash_ALG_ARGON2ID13: number;
    crypto_pwhash_SALTBYTES: number;
    crypto_pwhash_async(
      out: Buffer, passwd: Buffer, salt: Buffer, opslimit: number, memlimit: number, alg: number,
      cb: (err: Error | null) => void,
    ): void;
    crypto_pwhash_STRBYTES: number;
    crypto_pwhash_str_async(out: Buffer, passwd: Buffer, opslimit: number, memlimit: number, cb: (err: Error | null) => void): void;
    crypto_pwhash_str_verify_async(str: Buffer, passwd: Buffer, cb: (err: Error | null, ok: boolean) => void): void;
    crypto_box_PUBLICKEYBYTES: number;
    crypto_box_SECRETKEYBYTES: number;
    crypto_box_SEALBYTES: number;
    crypto_box_keypair(pk: Buffer, sk: Buffer): void;
    crypto_box_seal(c: Buffer, m: Buffer, pk: Buffer): void;
    crypto_box_seal_open(m: Buffer, c: Buffer, pk: Buffer, sk: Buffer): boolean;
    crypto_generichash(out: Buffer, input: Buffer, key?: Buffer): void;
  };
  export default sodium;
}
