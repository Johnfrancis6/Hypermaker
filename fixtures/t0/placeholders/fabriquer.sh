#!/usr/bin/env bash
# Placeholders de T0-technique, fabriqués à la main (brief §3) : aplats,
# damiers, faux logo avec et sans alpha. Volontairement médiocres :
# basse résolution, ratio faux, logo opaque. Les PNG commités font foi ;
# ce script n'est que la trace de leur fabrication (la sortie PNG peut
# varier d'une version de FFmpeg à l'autre).
set -euo pipefail
cd "$(dirname "$0")"
png() { ffmpeg -v error -y -f lavfi -i "$1" -frames:v 1 -fflags +bitexact -map_metadata -1 "$2"; }

# Fonds, 9:16
png "color=s=1080x1920,format=rgb24,geq=r='if(mod(floor(X/90)+floor(Y/90),2),38,24)':g='if(mod(floor(X/90)+floor(Y/90),2),44,28)':b='if(mod(floor(X/90)+floor(Y/90),2),58,36)'" fond_damier.png
png "color=c=0x1B2230:s=1080x1920,format=rgb24" fond_aplat.png
png "color=s=540x960,format=rgb24,geq=r='40+60*Y/H':g='30+20*Y/H':b='60+40*X/W'" fond_degrade_basse_def.png

# Sujets (boîte 700x460)
png "color=s=1400x920,format=rgb24,geq=r='if(lt(hypot(X-700,Y-460),380),230,70)':g='if(lt(hypot(X-700,Y-460),380),200,70)':b='if(lt(hypot(X-700,Y-460),380),170,80)'" sujet_disque.png
png "color=s=800x800,format=rgb24,geq=r='if(between(X,150,650)*between(Y,150,650),200,90)':g='if(between(X,150,650)*between(Y,150,650),210,90)':b='if(between(X,150,650)*between(Y,150,650),220,100)'" sujet_carre_mauvais_ratio.png
png "color=s=350x230,format=rgb24,geq=r='if(mod(floor(X/25)+floor(Y/25),2),220,120)':g='120':b='if(mod(floor(X/25)+floor(Y/25),2),60,160)'" sujet_basse_def.png

# Faux logo (boîte 200x80, source 400x160) : pastille + barre
FORME="lt(hypot(X-80,Y-80),60)+between(X,160,380)*between(Y,55,105)"
png "color=c=black@0:s=400x160,format=rgba,geq=r='255':g='90':b='31':a='if($FORME,255,0)'" logo_alpha.png
png "color=s=400x160,format=rgb24,geq=r='255':g='if($FORME,90,255)':b='if($FORME,31,255)'" logo_opaque.png
