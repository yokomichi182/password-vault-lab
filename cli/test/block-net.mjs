// --import で読み込む前処理。fetch と node:net・node:http(s) の接続・待ち受けを失敗させる(pwm-mcp が通信しないことのテスト用)。
import http from "node:http";
import https from "node:https";
import net from "node:net";

const blocked = () => {
  throw new Error("network blocked for test");
};

globalThis.fetch = blocked;
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
net.Server.prototype.listen = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
