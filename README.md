# SvxWeb – Webfrontend & Smart-Home-Integration für SVXLink

SvxWeb ist ein webbasiertes Dashboard für [SVXLink](https://github.com/sm0svx/svxlink), mit dem EchoLink-Konferenzen, Nodes und Logs komfortabel im Browser verwaltet werden können.  
Zusätzlich erlaubt es über DTMF-Befehle die **Integration ins Smart Home** via **MQTT → FHEM**.

---

## ✨ Funktionen

- **Webfrontend**
  - Starten, Stoppen und Neustarten des SVXLink-Dienstes  
  - Anzeige von Status, Versionen, Netzwerkadressen  
  - Verbindung zu EchoLink-Konferenzen oder einzelnen Nodes  
  - DTMF-Eingabe (per Tastatur oder virtuelles Keypad)  
  - Echtzeit-Loganzeige  

- **Smart-Home-Integration**
  - DTMF-Sequenzen werden in SVXLink erkannt  
  - Per Tcl-Hook an MQTT gesendet  
  - FHEM wertet die MQTT-Nachrichten aus und steuert Geräte  
  - Rückmeldung über Audio-Feedback („ok“/„error“)  

---

## 🏗️ Architektur

```
[ Funkgerät ] → [ SVXLink DTMF ] → [ Tcl-Hook → MQTT Publish ]
                                   → [ MQTT Broker ]
                                   → [ FHEM MQTT2_CLIENT / MQTT2_DEVICE ] → [ Smart-Home Device ]
```

---

## 🛠️ Installation

### Voraussetzungen
- Node.js (>= 18)  
- npm oder yarn  
- Eine laufende SVXLink-Installation  
- MQTT-Broker (z. B. Mosquitto)  
- FHEM mit Modulen `MQTT2_CLIENT` und `MQTT2_DEVICE`

### Backend starten
```bash
cd backend
npm install
node server.js
```

### Frontend starten
```bash
cd frontend
npm install
npm run dev
```

Das Frontend läuft anschließend auf [http://localhost:5173](http://localhost:5173).  
Das Backend (Express) läuft auf Port 3000 (oder konfiguriert in `server.js`).

---

## 🔗 API-Routen

- `GET /api/status` → Dienststatus  
- `GET /api/logs/tail?lines=150` → letzte Logzeilen  
- `GET /api/echolink/conferences` → Konferenzen  
- `GET /api/echolink/logins_structured` → eingeloggte Nutzer  
- `GET /api/network/addresses` → Netzwerkadressen  
- `GET /api/qrz/lookup?callsign=CALL` → QRZ-Daten  

Aktionen:  
- `POST /api/service/start|stop|restart`  
- `POST /api/reflector/connect`  
- `POST /api/reflector/disconnect`  
- `POST /api/dtmf`  

---

## 📡 SVXLink → MQTT → FHEM Integration

Dieses Projekt ermöglicht die Steuerung von Smart-Home-Geräten über DTMF-Befehle im SVXLink.  
DTMF-Sequenzen werden von SvxLink erkannt, per MQTT veröffentlicht und in FHEM ausgewertet.

### 1. Pakete installieren (Debian/Raspbian)

```bash
sudo apt update
sudo apt install -y svxlink-server mosquitto mosquitto-clients
```

### 2. SvxLink: DTMF-Hook → MQTT

Datei `/etc/svxlink/ev_mqtt_dtmf.tcl`:

```tcl
namespace eval ::MQTTBR {
  variable host   "192.168.188.49"
  variable port   1883
  variable user   ""    ;# falls Broker Auth nutzt
  variable pass   ""
  variable base   "svxlink"
  variable prefix "77"
  variable buf ""

  array set MAP {
    11 {fhem/cmnd/cmnd_1 on}
    10 {fhem/cmnd/cmnd_1 off}
  }
}

proc ::MQTTBR::pub {topic payload {retain 0}} {
  variable host; variable port; variable user; variable pass
  set args [list mosquitto_pub -h $host -p $port -t $topic -m $payload -q 0]
  if {$retain} { lappend args -r }
  if {$user ne ""} { lappend args -u $user -P $pass }
  exec {*}$args &
}

proc ::MQTTBR::on_dtmf {digit} {
  variable base; variable prefix; variable buf
  append buf $digit
  if {$digit eq "#"} {
    if {[string first $prefix $buf] == 0} {
      set code [string range $buf [string length $prefix] end-1]
      if {[info exists ::MQTTBR::MAP($code)]} {
        foreach {t p} $::MQTTBR::MAP($code) {}
        catch { ::MQTTBR::pub $t $p }
        catch { playMsg "Core" "ok" }
      } else {
        catch { playMsg "Core" "error" }
      }
    }
    set buf ""
  }
}
```

In `/etc/svxlink/events.d/Logic.tcl` einfügen:

```tcl
source /etc/svxlink/ev_mqtt_dtmf.tcl

proc dtmf_digit_received {digit duration} {
  catch { ::MQTTBR::on_dtmf $digit }
}
```

Neu starten:
```bash
sudo systemctl restart svxlink
```

### 3. MQTT Broker prüfen

```bash
mosquitto_sub -h 192.168.188.49 -t 'fhem/cmnd/#' -v
```

Test:  
- `77 11 #` → `fhem/cmnd/cmnd_1 on`  
- `77 10 #` → `fhem/cmnd/cmnd_1 off`

### 4. FHEM Konfiguration

```text
define MqttIO_svxlink MQTT2_CLIENT 192.168.188.49:1883
attr MqttIO_svxlink room System

define MQ_plug_01 MQTT2_DEVICE
attr MQ_plug_01 IODev MqttIO_svxlink
attr MQ_plug_01 room test
attr MQ_plug_01 readingList fhem/cmnd/cmnd_1:(.*) state
attr MQ_plug_01 setList   on:noArg  fhem/cmnd/cmnd_1 on   off:noArg fhem/cmnd/cmnd_1 off
attr MQ_plug_01 stateFormat state
attr MQ_plug_01 event-on-change-reading state
```

Notify:  
```text
define n_MQ_plug_01 notify MQ_plug_01:state:.* set HUEDevice50 $EVENT
```

### 5. Tests

- `set MQ_plug_01 on` → MQTT `fhem/cmnd/cmnd_1 on`  
- Funkgerät `77 11 #` → SvxLink → MQTT → FHEM Reading `on` → Hue-Lampe an  

---

## 🚧 Roadmap

- Status-Topics (`stat/...`) für retained States  
- Szenensteuerung per DTMF-Codes  
- TLS/ACL-Absicherung für MQTT  
- Erweiterte FHEM-Vorlagen  

---

## 📜 Lizenz

MIT-Lizenz – siehe [LICENSE](LICENSE).
