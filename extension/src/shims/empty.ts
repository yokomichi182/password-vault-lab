// kdbxweb が Node 用に require する "crypto" の代わり。ブラウザでは WebCrypto(crypto.subtle)が使われ、この空のモジュールは呼ばれない。
export default {};
