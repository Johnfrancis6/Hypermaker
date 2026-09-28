// Analyse d'une trace strace de rendu : une donnée a-t-elle franchi la
// frontière ? (brief §11, règle au niveau des octets, pas de l'appel système)
//
// Un rendu échoue si :
//   - une connexion TCP (ou de type inconnu) vise une adresse hors boucle locale ;
//   - une connexion UDP vise une adresse hors boucle locale, SAUF la sonde de
//     joignabilité IPv6 de Chrome ;
//   - des octets sont envoyés vers une adresse hors boucle locale, ou sur un
//     descripteur associé à une telle adresse.
// Une tentative compte : un connect() refusé (ENETUNREACH sous unshare -rn)
// prouve que le processus a voulu sortir.
//
// La sonde tolérée est la conjonction de TOUTES ces conditions :
//   AF_INET6, SOCK_DGRAM, connect() vers exactement 2001:4860:4860::8888 port
//   443, et AUCUN appel d'envoi (write, writev, sendto, sendmsg, sendmmsg) sur
//   ce socket pendant toute sa vie, de socket() à close(). Pinée à l'adresse :
//   une sonde vers un autre hôte fait échouer.
//
// Suivi des descripteurs : strace -f préfixe chaque ligne par l'identifiant
// de THREAD ; les threads d'un processus partagent leur table de
// descripteurs. Les clone() sont suivis pour savoir quelle table un thread
// utilise (CLONE_FILES : partagée ; sinon copie, qui pointe vers les mêmes
// sockets). dup/dup2/dup3 aliasent le socket. Limites connues : fcntl(F_DUPFD)
// et le passage de descripteurs par SCM_RIGHTS ne sont pas suivis.
export const BOUCLE_LOCALE = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const SONDE_IPV6_CHROME = { adresse: "2001:4860:4860::8888", port: 443 };
const ENVOIS = new Set(["write", "writev", "send", "sendto", "sendmsg", "sendmmsg"]);

// Fusionne « <unfinished ...> » et « <... x resumed> » d'un même thread.
function lignesCompletes(trace) {
  const enCours = new Map();
  const sortie = [];
  for (const brute of trace.split("\n")) {
    const reprise = brute.match(/^(\d+) <\.\.\. [a-z0-9_]+ resumed>(.*)$/);
    if (reprise) {
      const debut = enCours.get(reprise[1]);
      enCours.delete(reprise[1]);
      if (debut !== undefined) sortie.push(debut + reprise[2]);
      continue;
    }
    const interrompue = brute.match(/^(\d+ .*?) <unfinished \.\.\.>$/);
    if (interrompue) {
      enCours.set(brute.split(" ")[0], interrompue[1]);
      continue;
    }
    sortie.push(brute);
  }
  // Appel jamais repris (processus tué) : on le garde, résultat inconnu.
  for (const debut of enCours.values()) sortie.push(debut + ") = ?");
  return sortie;
}

// Adresse IP et port dans les arguments d'un appel.
function adresseDe(args) {
  const v4 = args.match(/sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)/);
  if (v4) return { famille: "AF_INET", adresse: v4[2], port: Number(v4[1]) };
  const v6 = args.match(/sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"/);
  if (v6) return { famille: "AF_INET6", adresse: v6[2], port: Number(v6[1]) };
  return null;
}

export function analyserTrace(trace) {
  const tableDe = new Map(); // tid → Map(fd → socket)
  const table = (tid) => {
    if (!tableDe.has(tid)) tableDe.set(tid, new Map());
    return tableDe.get(tid);
  };
  const hotes = new Map();
  const violations = [];
  const sondes = [];

  for (const ligne of lignesCompletes(trace)) {
    const m = ligne.match(/^(\d+) ([a-z0-9_]+)\((.*)\)\s+= (-?\d+|\?)/);
    if (!m) continue;
    const [, tid, appel, args, retTexte] = m;
    const ret = retTexte === "?" ? null : Number(retTexte);
    const fd = Number(args.match(/^(\d+)/)?.[1]);
    const t = table(tid);

    if (/^(clone|clone3|fork|vfork)$/.test(appel) && ret > 0) {
      const enfant = String(ret);
      if (/CLONE_FILES/.test(args)) tableDe.set(enfant, t);
      else tableDe.set(enfant, new Map(t)); // copie : mêmes sockets, table distincte
    } else if (appel === "socket" && ret >= 0) {
      const [famille, type] = args.split(",").map((s) => s.trim());
      t.set(ret, { famille, type: type.split("|")[0], sonde: false, envois: 0, adresses: [] });
    } else if (/^dup[23]?$/.test(appel) && ret >= 0) {
      if (t.has(fd)) t.set(ret, t.get(fd));
    } else if (appel === "close") {
      t.delete(fd);
    } else if (appel === "connect") {
      const a = adresseDe(args);
      if (!a) continue; // AF_UNIX, AF_NETLINK…
      hotes.set(a.adresse, (hotes.get(a.adresse) ?? 0) + 1);
      const s = t.get(fd) ?? { famille: a.famille, type: "inconnu", sonde: false, envois: 0, adresses: [] };
      t.set(fd, s);
      s.adresses.push(a.adresse);
      if (BOUCLE_LOCALE.has(a.adresse)) continue;
      const estSonde = s.famille === "AF_INET6" && s.type === "SOCK_DGRAM" && a.adresse === SONDE_IPV6_CHROME.adresse && a.port === SONDE_IPV6_CHROME.port && s.envois === 0;
      if (estSonde) {
        s.sonde = true;
        sondes.push({ tid, fd });
      } else {
        const nature = s.type === "SOCK_DGRAM" ? "UDP" : s.type === "SOCK_STREAM" ? "TCP" : `type ${s.type}`;
        violations.push(`connexion ${nature} vers ${a.adresse}:${a.port} (thread ${tid}, fd ${fd}, résultat ${retTexte})`);
      }
    } else if (ENVOIS.has(appel)) {
      const a = adresseDe(args);
      if (a) {
        hotes.set(a.adresse, (hotes.get(a.adresse) ?? 0) + 1);
        if (!BOUCLE_LOCALE.has(a.adresse)) violations.push(`${appel} vers ${a.adresse}:${a.port} (thread ${tid}, fd ${fd})`);
      }
      const s = t.get(fd);
      if (!s) continue;
      s.envois++;
      if (s.sonde) violations.push(`${appel} sur le socket de la sonde IPv6 (thread ${tid}, fd ${fd}) : la sonde ne doit émettre aucun octet`);
      else if (s.adresses.some((x) => !BOUCLE_LOCALE.has(x))) violations.push(`${appel} sur un socket associé à ${s.adresses.join(", ")} (thread ${tid}, fd ${fd})`);
    }
  }
  return { hotes, violations, sondes: sondes.length };
}
