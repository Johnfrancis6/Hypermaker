// Tests de l'analyse de trace. Les lignes reprennent les formats RÉELS de
// strace 5.16 relevés sur un rendu (clone3, vfork, unfinished/resumed,
// inet_pton IPv6). Ce qui compte : chaque condition de la sonde, retirée
// seule, fait échouer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyserTrace } from "./journal-reseau.mjs";

const socketUdp6 = (tid, fd) => `${tid} socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP) = ${fd}`;
const socketTcp6 = (tid, fd) => `${tid} socket(AF_INET6, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_IP) = ${fd}`;
const connect6 = (tid, fd, adresse, port, ret = "-1 ENETUNREACH (Network is unreachable)") =>
  `${tid} connect(${fd}, {sa_family=AF_INET6, sin6_port=htons(${port}), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "${adresse}", &sin6_addr), sin6_scope_id=0}, 28) = ${ret}`;
const connect4 = (tid, fd, adresse, port, ret = "0") =>
  `${tid} connect(${fd}, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${adresse}")}, 16) = ${ret}`;
const SONDE = "2001:4860:4860::8888";
const analyser = (...lignes) => analyserTrace(lignes.join("\n"));

test("sonde réelle : socket UDP6, connect 2001:4860:4860::8888:443, close — tolérée", () => {
  const r = analyser(socketUdp6(132093, 22), connect6(132093, 22, SONDE, 443), `132093 close(22) = 0`);
  assert.deepEqual(r.violations, []);
  assert.equal(r.sondes, 1);
});

test("sonde + write sur le même descripteur → échec", () => {
  const r = analyser(socketUdp6(1, 22), connect6(1, 22, SONDE, 443, "0"), `1 write(22, "x", 1) = 1`);
  assert.match(r.violations.join(), /sonde IPv6/);
});

test("sonde + sendmmsg même refusé → échec (une tentative d'envoi suffit)", () => {
  const r = analyser(socketUdp6(1, 22), connect6(1, 22, SONDE, 443, "0"), `1 sendmmsg(22, [{msg_hdr={msg_name=NULL}}], 1, MSG_NOSIGNAL) = -1 ENETUNREACH (Network is unreachable)`);
  assert.match(r.violations.join(), /sendmmsg sur le socket de la sonde/);
});

test("sonde écrite par un AUTRE thread du même processus (clone3 CLONE_THREAD) → échec", () => {
  const r = analyser(
    `10 clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM, exit_signal=0} => {parent_tid=[11]}, 88) = 11`,
    socketUdp6(10, 22),
    connect6(10, 22, SONDE, 443, "0"),
    `11 write(22, "x", 1) = 1`,
  );
  assert.match(r.violations.join(), /sonde IPv6/);
});

test("sonde héritée par un processus enfant (vfork) puis écrite → échec", () => {
  const r = analyser(socketUdp6(10, 22), connect6(10, 22, SONDE, 443, "0"), `10 vfork() = 20`, `20 sendto(22, "x", 1, 0, NULL, 0) = 1`);
  assert.match(r.violations.join(), /sonde IPv6/);
});

test("sonde aliasée par dup2 puis écrite → échec", () => {
  const r = analyser(socketUdp6(1, 22), connect6(1, 22, SONDE, 443, "0"), `1 dup2(22, 40) = 40`, `1 write(40, "x", 1) = 1`);
  assert.match(r.violations.join(), /sonde IPv6/);
});

test("descripteur réutilisé après close : l'ancienne sonde ne contamine pas un socket local", () => {
  const r = analyser(
    socketUdp6(1, 22), connect6(1, 22, SONDE, 443), `1 close(22) = 0`,
    socketTcp6(1, 22), connect4(1, 22, "127.0.0.1", 40247), `1 write(22, "GET / HTTP/1.1", 14) = 14`,
  );
  assert.deepEqual(r.violations, []);
});

test("interrompu / repris : la sonde fusionnée est reconnue", () => {
  const r = analyser(
    `5 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP <unfinished ...>`,
    `6 close(3) = 0`,
    `5 <... socket resumed>)            = 22`,
    connect6(5, 22, SONDE, 443),
  );
  assert.deepEqual(r.violations, []);
  assert.equal(r.sondes, 1);
});

// Chaque condition de la conjonction, retirée seule, fait échouer.
test("même adresse, port 53 au lieu de 443 → échec", () => {
  const r = analyser(socketUdp6(1, 22), connect6(1, 22, SONDE, 53));
  assert.match(r.violations.join(), /UDP vers 2001:4860:4860::8888:53/);
});
test("autre hôte, port 443, UDP → échec (pinée à l'adresse)", () => {
  const r = analyser(socketUdp6(1, 22), connect6(1, 22, "2001:4860:4860::8844", 443));
  assert.match(r.violations.join(), /UDP vers 2001:4860:4860::8844:443/);
});
test("même adresse et port, mais TCP → échec", () => {
  const r = analyser(socketTcp6(1, 22), connect6(1, 22, SONDE, 443));
  assert.match(r.violations.join(), /TCP vers 2001:4860:4860::8888:443/);
});
test("même adresse et port, socket de type inconnu (non vu) → échec", () => {
  const r = analyser(connect6(1, 22, SONDE, 443));
  assert.match(r.violations.join(), /type inconnu/);
});
test("socket déjà utilisé pour envoyer avant de viser l'adresse de la sonde → échec", () => {
  const r = analyser(socketUdp6(1, 22), `1 write(22, "x", 1) = 1`, connect6(1, 22, SONDE, 443));
  assert.match(r.violations.join(), /UDP vers 2001:4860:4860::8888:443/);
});

// Le reste de la règle.
test("DNS : connect UDP vers le résolveur (ENETUNREACH) → échec", () => {
  const r = analyser(`1 socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_IP) = 5`, connect4(1, 5, "10.255.255.254", 53, "-1 ENETUNREACH (Network is unreachable)"));
  assert.match(r.violations.join(), /UDP vers 10\.255\.255\.254:53/);
});
test("sendto avec adresse hors boucle locale sur socket non connecté → échec", () => {
  const r = analyser(`1 socket(AF_INET, SOCK_DGRAM, IPPROTO_IP) = 5`, `1 sendto(5, "q", 1, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.8.8")}, 16) = 1`);
  assert.match(r.violations.join(), /sendto vers 8\.8\.8\.8:53/);
});
test("boucle locale IPv4 et IPv6, AF_UNIX, netlink : aucune violation", () => {
  const r = analyser(
    socketTcp6(1, 7), connect6(1, 7, "::1", 33439, "-1 EINPROGRESS (Operation now in progress)"), `1 write(7, "x", 1) = 1`,
    `1 socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 8`, connect4(1, 8, "127.0.0.1", 40247),
    `1 connect(9, {sa_family=AF_UNIX, sun_path="/run/x"}, 110) = 0`,
    `1 sendmsg(4, {msg_name={sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}, msg_namelen=12}, 0) = 48`,
  );
  assert.deepEqual(r.violations, []);
  assert.equal(r.hotes.get("::1"), 1);
  assert.equal(r.hotes.get("127.0.0.1"), 1);
});
