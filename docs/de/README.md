# ioBroker.mach – Kurzfassung auf Deutsch

ioBroker-Adapter für Adria-Wohnwagen und -Reisemobile mit **MACH-Box**
(Hersteller Solvesall d.o.o.). Er meldet sich mit deinem eigenen
MACH-Account über die MACH-Cloud an, so wie die App über LTE.

**Inoffiziell:** nicht von Adria oder Solvesall, nicht von ihnen unterstützt.
Der Hersteller kann das Protokoll jederzeit ändern. Nutzung auf eigenes
Risiko, besonders beim Schalten der Heizung aus der Ferne.

- Liest **alle Werte** der Box: beim Verbinden, alle 15 Minuten und kurz
  nach jeder Änderung. Benannt wie in der App unter `values.*`.
- **Heizung** schalten (`named.Heizung_Schalter`) und Sollwert setzen
  (`named.Heizung_Sollwert`). Andere Schalter noch nicht.
- `control.reboot` startet die Box neu (höchstens alle 10 Minuten).
- Voraussetzung: Box mit aktivem LTE, MACH-App-Account mit dem Fahrzeug.
- Installation: im ioBroker-Admin unter Adapter nach „mach" suchen.
- Konfiguration: E-Mail, Passwort und `machId` (App → Geräte-Einstellungen).
- Für Automationen `info.lastAllValuesAt` prüfen: Sind die Daten älter als
  ca. 30 Minuten, hat die Box vermutlich keine Verbindung.

**Lizenz:** Der Adapter ist frei unter der [MIT-Lizenz](../../LICENSE): nutzen,
kopieren, ändern, weitergeben, auch kommerziell. Sie gilt nur für den hier
geschriebenen Code und die Doku. An der MACH-App, der Firmware der Box, dem
MACH-Backend und deren Code, Daten und Marken hat der Autor **keine Rechte**;
sie gehören Solvesall d.o.o. und Adria Mobil d.o.o. und werden hier nicht
lizenziert. Dieses Repository enthält nichts davon.

Die ausführliche Beschreibung steht im [englischen README](../../README.md).
