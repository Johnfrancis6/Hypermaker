// Mesures DOM partagées. UNE seule implémentation, utilisée par le runtime
// (rétrécissement, overflow: "shrink") et par le lint (R5). Si les deux
// comptaient les lignes différemment, R5 contredirait l'écran par
// intermittence. Le lint appelle window.hmMesure dans la page, il ne
// réimplémente rien.
(function () {
  "use strict";

  // Lignes RENDUES : une ligne = une ordonnée distincte parmi les rectangles
  // du texte. Ne jamais déduire les lignes de scrollHeight : il ne descend pas
  // sous la hauteur de la boîte, donc l'estimation grossit quand la police
  // rétrécit.
  function lignes(el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    var tops = {};
    Array.prototype.forEach.call(r.getClientRects(), function (x) {
      tops[Math.round(x.top)] = true;
    });
    return Object.keys(tops).length;
  }

  // Débordement au sens de R5 : contenu plus grand que la boîte, ou plus de
  // lignes que max_lines.
  function deborde(el, maxLignes) {
    return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth || lignes(el) > maxLignes;
  }

  window.hmMesure = { lignes: lignes, deborde: deborde };
})();
