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
          if (s.overflow === "shrink") {
            while (window.hmMesure.deborde(el, s.max_lignes) && taille > s.taille_min_px) {
              taille -= 1;
              el.style.fontSize = taille + "px";
            }
          }
          etat.textes.push({ text_id: s.text_id, scene_id: sc.scene_id, taille_finale_px: taille });
        });
      });

      // 4. Timeline unique, en pause. Tous les temps sont des secondes
      //    issues de frame / fps (inject.mjs).
      //
      //    L'état à t = 0 est posé en style inline AVANT la timeline, et la
      //    timeline ne porte que des CHANGEMENTS, jamais deux instructions
      //    contradictoires sur un même élément à une même position. Mesuré le
      //    28/09 : deux set() à la position 0 (caché, puis visible) laissaient
      //    le résultat dépendre de l'historique de seek de chaque worker du
      //    moteur — frame 0 vide dans tous les rendus, frames 150 à 224 vides
      //    dans un rendu sur six. Sur une page fraîche, seek(0) ne rend rien :
      //    l'état à 0 doit donc déjà être dans le DOM.
      //
      //    will-change: opacity sur tout élément dont l'opacité s'anime. Sans
      //    lui, Chrome choisit AU LANCEMENT, par heuristique, de composer ou non
      //    l'élément sur sa propre couche ; les deux chemins mélangent à 1 ou 2
      //    niveaux près. Mesuré le 29/09 sur C : deux hash_frames stables
      //    (d06a…, 575c…) selon le lancement, 12 rendus sur 15 différents de la
      //    référence ; arrondir l'opacité au 1/255 ne change aucun pixel (ce
      //    n'est pas la valeur) ; avec will-change, 16 rendus sur 16 identiques.
      function animeOpacite(el) {
        el.style.willChange = "opacity";
      }
      function etatInitial(el, visible) {
        el.style.visibility = visible ? "inherit" : "hidden";
        el.style.opacity = visible ? "1" : "0";
      }
      var tl = gsap.timeline({ paused: true });
      d.scenes.forEach(function (sc, i) {
        var section = scenes[i];
        var visibleA0 = sc.visible_debut_s === 0 && !sc.fondu_entree;
        etatInitial(section, visibleA0);
        animeOpacite(section);
        if (sc.fondu_entree) {
          tl.fromTo(section, { autoAlpha: 0 }, { autoAlpha: 1, duration: sc.fondu_entree.duree_s, ease: ease(sc.fondu_entree.easing), immediateRender: false }, sc.fondu_entree.debut_s);
        } else if (!visibleA0) {
          tl.set(section, { autoAlpha: 1 }, sc.visible_debut_s);
        }
        if (sc.visible_fin_s < d.duree_s) tl.set(section, { autoAlpha: 0 }, sc.visible_fin_s);
        sc.slots.forEach(function (s) {
          if (s.nature !== "texte") return;
          var el = section.querySelector('[data-slot="' + s.slot + '"]');
          if (s.animation.type !== "fade_in") return echec(s.text_id + " : animation " + s.animation.type + " sans amplitude dans la composition, non rendable");
          el.style.opacity = "0"; // fade_in part de 0, quelle que soit sa position
          animeOpacite(el);
          tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: s.animation.duree_s, ease: ease(s.animation.easing), immediateRender: false }, s.animation.debut_s);
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
