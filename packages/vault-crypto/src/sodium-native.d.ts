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
  };
  export default sodium;
}
