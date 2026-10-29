# Area C e ZTL Milano

Sito per chi va a Milano in auto: mostra **Area C**, le **ZTL** e i **varchi** con le telecamere, dice se Area C è attiva in questo momento, se la propria auto può entrare, **calcola percorsi che evitano Area C e le ZTL** e, con la posizione del telefono, avvisa quando si è dentro o vicino a una zona.

Sito: https://samugirone2003-boop.github.io/milano-ztl/

## Da dove vengono i dati

| Cosa | Fonte | Come si aggiorna |
| --- | --- | --- |
| Perimetri di Area C e ZTL | [Aree pedonali e ZTL](https://dati.comune.milano.it/dataset/ds51_trafficotrasporti_aree_pedonali_ztl), dati aperti del Comune | automatico, ogni lunedì |
| Varchi di Area C | [Varchi Area C](https://dati.comune.milano.it/dataset/ds82_infogeo_varchi_elettronici_localizzazione_), dati aperti del Comune | automatico, ogni lunedì |
| ZTL mancanti nei dati aperti (Quadrilatero della Moda, Isola) | `data/manual_zones.geojson`, ricalcate dalle mappe ufficiali | controllo mensile delle pagine del Comune; vengono ignorate quando il Comune le pubblica nei dati aperti |
| Orari, ticket e divieti per classe Euro | `data/rules.json`, dalle pagine ufficiali del Comune | controllo mensile; se passano più di 30 giorni GitHub apre una segnalazione |

L'aggiornamento automatico è in `.github/workflows/update-data.yml` e usa `scripts/update_data.py` (solo libreria standard di Python). Si può avviare anche a mano da GitHub: *Actions → Aggiorna dati Area C e ZTL → Run workflow*.

## Percorsi

I percorsi sono calcolati da [OpenRouteService](https://openrouteservice.org) con una chiave gratuita personale, che ognuno incolla nel sito e resta salvata solo sul proprio dispositivo. Le zone da evitare sono in `data/avoid.geojson` (generato dallo script): perimetri semplificati, con Area C stretta di 12 m perché la cerchia dei Bastioni resti percorribile. Gli indirizzi sono cercati con Nominatim (OpenStreetMap).

## Aggiungere o correggere una ZTL

1. Aggiungi la zona in `data/manual_zones.geojson` (stesso formato del Quadrilatero), con fonte e data del controllo.
2. Esegui `python3 scripts/update_data.py` e fai commit e push.

## Quando cambiano le regole di Area C

Modifica `data/rules.json` (orari, prezzo del ticket, date dei divieti per benzina e diesel), aggiorna `checked` con la data del controllo e le date `lastUpdate` delle pagine in `watch`.

## Note

- Strumento non ufficiale: in caso di dubbio valgono la segnaletica e le pagine del Comune di Milano.
- La posizione viene usata solo sul telefono e non viene inviata da nessuna parte.
- Dati © Comune di Milano, licenza CC BY. Mappa: Esri, © OpenStreetMap.
