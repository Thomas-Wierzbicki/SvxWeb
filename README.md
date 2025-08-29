# SVXLink → MQTT → FHEM Integration

Dieses Projekt ermöglicht die Steuerung von Smart-Home-Geräten über DTMF-Befehle im SVXLink.  
DTMF-Sequenzen werden von SvxLink erkannt, per MQTT veröffentlicht und in FHEM ausgewertet.

---

## Architektur

```
[ Funkgerät ] → [ SVXLink DTMF ] → [ Tcl-Hook → MQTT Publish ]
                                   → [ MQTT Broker ]
                                   → [ FHEM MQTT2_CLIENT / MQTT2_DEVICE ] → [ Smart-Home Device ]
```

---

## 1. Voraussetzungen

### Pakete installieren (Debian/Raspbian)
```bash
sudo apt update
sudo apt install -y svxlink-server mosquitto mosquitto-clients
```

### FHEM
- Aktuelle FHEM-Installation  
- Module `MQTT2_CLIENT` und `MQTT2_DEVICE` (Standard)

---

## 2. SvxLink: DTMF-Hook → MQTT

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

---

## 3. MQTT Broker prüfen

### Lauschen
```bash
mosquitto_sub -h 192.168.188.49 -t 'fhem/cmnd/#' -v
```

### Test
- Funkgerät: `77 11 #` → sollte `fhem/cmnd/cmnd_1 on` erscheinen  
- Funkgerät: `77 10 #` → sollte `fhem/cmnd/cmnd_1 off` erscheinen

---

## 4. FHEM: MQTT2_CLIENT und MQTT2_DEVICE

### MQTT2_CLIENT
```text
define MqttIO_svxlink MQTT2_CLIENT 192.168.188.49:1883
attr MqttIO_svxlink room System
```

### MQTT2_DEVICE für Plug
```text
define MQ_plug_01 MQTT2_DEVICE
attr MQ_plug_01 IODev MqttIO_svxlink
attr MQ_plug_01 room test
attr MQ_plug_01 readingList fhem/cmnd/cmnd_1:(.*) state
attr MQ_plug_01 setList \
  on:noArg  fhem/cmnd/cmnd_1 on \
  off:noArg fhem/cmnd/cmnd_1 off
attr MQ_plug_01 stateFormat state
attr MQ_plug_01 event-on-change-reading state
```

### notify: Plug → Hue-Lampe
```text
define n_MQ_plug_01 notify MQ_plug_01:state:.* set HUEDevice50 $EVENT
```

---

## 5. Tests

- `set MQ_plug_01 on` → FHEM sendet MQTT `fhem/cmnd/cmnd_1 on`  
- Funkgerät `77 11 #` → SvxLink sendet `fhem/cmnd/cmnd_1 on` → FHEM Reading `state=on` → notify schaltet `HUEDevice50 on`  
- Funkgerät `77 10 #` → … analog `off`

---

## 6. Weiterentwicklung (Empfehlungen)

- **Status-Topics (`stat/…`)**: Zusätzlich `fhem/stat/cmnd_1` retained publishen → FHEM kennt Zustand auch nach Neustart.  
- **Scenes:** DTMF-Codes für Szenen definieren (z. B. `77 50 #` → mehrere Lampen schalten).  
- **Audio-Feedback:** `playMsg "Core" "ok"`/`"error"` für Benutzerbestätigung.  
- **Absicherung:** Mosquitto mit ACL/Passwort, TLS falls nötig.  
- **Monitoring:** Heartbeat-Topic (`svxlink/status`) mit `retained` für einfache Überwachung.  
- **FHEM-Vorlagen:** Zentrales DOIF/notify, das alle `fhem/cmnd/<name>` auf entsprechende Devices mappt.  

---

## 7. Troubleshooting

- **Kein State in FHEM:** `readingList` muss `(.*)` enthalten.  
- **Notify feuert nicht:** `MQ_plug_01:state:.*` ohne Leerzeichen im Regex.  
- **Events nicht aktualisiert:** für Debug `attr MQ_plug_01 event-on-update-reading state` setzen.  
- **Topic stimmt nicht:** per `mosquitto_sub` prüfen, welcher String wirklich gesendet wird.

---
