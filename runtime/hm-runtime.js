// Runtime de page HyperMaker — exécute des valeurs DÉJÀ RÉSOLUES.
//
// inject.mjs a tout calculé côté Node (liaison slot, temps en secondes
// passés par le numéro de frame, polices, chemins). Ce script ne fait que :
// cloner la scène du template, remplir les [data-slot], vérifier que nos
// polices se sont chargées, appliquer le rétrécissement déclaré par
// overflow: "shrink", puis construire UNE timeline GSAP en pause.
//
// Aucun choix ici : une valeur absente ou un type non géré est une erreur,
// jamais un défaut. Pas d'horloge murale, pas d'aléa, pas de
// requestAnimationFrame : la timeline est seekée par le moteur.
//
// Échec = la timeline n'est PAS enregistrée : le moteur ne peut pas rendre,
// au lieu de rendre faux. L'état est exposé dans window.__hm pour le lint.
(function () {
  "use strict";
  var etat = (window.__hm = { pret: false, polices_ok: false, polices: [], textes: [], erreurs: [] });
  function echec(message) {
    etat.erreurs.push(message);
    console.error("[hm] " + message);
  }

  var d = JSON.parse(document.getElementById("hm-donnees").textContent);
  var root = document.getElementById("root");
  var modele = document.getElementById("hm-scene");
  gsap.registerPlugin(CustomEase);

  var eases = {};
  function ease(b) {
    var cle = b.join(",");
    if (!eases[cle]) eases[cle] = CustomEase.create("hm" + Object.keys(eases).length, "M0,0 C" + b[0] + "," + b[1] + " " + b[2] + "," + b[3] + " 1,1");
    return eases[cle];
  }

  // 1. Construction du DOM, scène par scène. Une scène plus tardive est
  //    au-dessus : le fondu d'entrée de la suivante couvre la précédente.
  var scenes = d.scenes.map(function (sc, i) {
    var frag = modele.content.cloneNode(true);
    var section = frag.querySelector(".hm-scene");
    section.setAttribute("data-scene", sc.scene_id);
    section.style.zIndex = String(i);
    sc.slots.forEach(function (s) {
      var el = section.querySelector('[data-slot="' + s.slot + '"]');
      if (!el) return echec(sc.scene_id + " : slot " + s.slot + " absent du template");
      el.style.left = s.box.x + "px";
      el.style.top = s.box.y + "px";
      el.style.width = s.box.width + "px";
      el.style.height = s.box.height + "px";
      el.style.zIndex = String(s.z_index);
      if (s.nature === "image") {
        el.src = s.src;
        el.style.objectFit = s.fit;
        el.style.opacity = String(s.opacity);
      } else {
        el.textContent = s.contenu;
        el.style.fontFamily = '"' + s.famille + '"';
        el.style.fontWeight = String(s.poids);
        el.style.fontStyle = s.style;
        el.style.fontSize = s.taille_px + "px";
        el.style.lineHeight = String(s.interligne);
        el.style.color = s.couleur;
        el.style.textAlign = s.align;
      }
    });
    root.appendChild(frag);
    return section;
  });

  // 2. Polices : chargement explicite, puis double contrôle. On ne se fie
  //    pas au seul document.fonts.check(), qui répond vrai quand AUCUNE
  //    face ne correspond : on exige aussi une FontFace de notre famille
  //    privée, au bon poids, à l'état « loaded ».
  var demandes = d.polices.map(function (p) {
    return p.style + " " + p.poids + " 16px \"" + p.famille + "\"";
  });
  Promise.all(demandes.map(function (q) { return document.fonts.load(q); }))
    .then(function () {
      var faces = [];
      document.fonts.forEach(function (f) { faces.push(f); });
      etat.polices = d.polices.map(function (p, i) {
        var face = faces.filter(function (f) {
          return f.family.replace(/"/g, "") === p.famille && String(f.weight) === String(p.poids) && f.style === p.style;
        })[0];
        return { famille: p.famille, poids: p.poids, style: p.style, check: document.fonts.check(demandes[i]), face: face ? face.status : "absente" };
      });
      etat.polices_ok = etat.polices.every(function (p) { return p.check && p.face === "loaded"; });
      if (!etat.polices_ok) return echec("police non chargée : " + JSON.stringify(etat.polices));

      // 3. Rétrécissement (overflow: "shrink") : taille décroissante, pas de
      //    1 px, jusqu'à ce que le texte tienne dans sa boîte et son nombre
      //    de lignes, sans descendre sous le plancher. S'il ne tient pas au
      //    plancher, on le laisse déborder : c'est R5 (lint) qui rejette, le
      //    runtime ne masque rien.
      d.scenes.forEach(function (sc, i) {
        sc.slots.forEach(function (s) {
          if (s.nature !== "texte") return;
          var el = scenes[i].querySelector('[data-slot="' + s.slot + '"]');
          if (s.overflow !== "shrink" && s.overflow !== "wrap") return echec(s.text_id + " : overflow " + s.overflow + " non géré en T0");
          var taille = s.taille_px;
          // Lignes RENDUES : une ligne = une ordonnée distincte parmi les
          // rectangles du texte. Ne pas déduire les lignes de scrollHeight :
          // il ne descend jamais sous la hauteur de la boîte, donc l'estimation
          // grossit quand la police rétrécit.
          function lignes() {
            var r = document.createRange();
            r.selectNodeContents(el);
            var tops = {};
            Array.prototype.forEach.call(r.getClientRects(), function (x) { tops[Math.round(x.top)] = true; });
            return Object.keys(tops).length;
          }
          function deborde() { return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth || lignes() > s.max_lignes; }
          if (s.overflow === "shrink") {
            while (deborde() && taille > s.taille_min_px) {
              taille -= 1;
              el.style.fontSize = taille + "px";
            }
          }
          etat.textes.push({ text_id: s.text_id, scene_id: sc.scene_id, taille_finale_px: taille });
        });
      });

      // 4. Timeline unique, en pause. Tous les temps sont des secondes
      //    issues de frame / fps (inject.mjs).
      var tl = gsap.timeline({ paused: true });
      d.scenes.forEach(function (sc, i) {
        var section = scenes[i];
        tl.set(section, { autoAlpha: 0 }, 0);
        if (sc.fondu_entree) {
          tl.fromTo(section, { autoAlpha: 0 }, { autoAlpha: 1, duration: sc.fondu_entree.duree_s, ease: ease(sc.fondu_entree.easing) }, sc.fondu_entree.debut_s);
        } else {
          tl.set(section, { autoAlpha: 1 }, sc.visible_debut_s);
        }
        if (sc.visible_fin_s < d.duree_s) tl.set(section, { autoAlpha: 0 }, sc.visible_fin_s);
        sc.slots.forEach(function (s) {
          if (s.nature !== "texte") return;
          var el = section.querySelector('[data-slot="' + s.slot + '"]');
          if (s.animation.type !== "fade_in") return echec(s.text_id + " : animation " + s.animation.type + " sans amplitude dans la composition, non rendable");
          tl.set(el, { opacity: 0 }, 0);
          tl.to(el, { opacity: 1, duration: s.animation.duree_s, ease: ease(s.animation.easing) }, s.animation.debut_s);
        });
      });
      tl.set({}, {}, d.duree_s); // la timeline couvre exactement le canvas
      if (etat.erreurs.length) return;

      window.__timelines = window.__timelines || {};
      window.__timelines.root = tl;
      etat.pret = true;
    })
    .catch(function (e) { echec("exception : " + e); });
})();
