# --- Simple DTMF → MQTT Bridge for SvxLink (publish only) ---
# Abhängigkeit: mosquitto_pub

namespace eval ::MQTTBR {
  # MQTT Broker
  variable host   "192.168.188.49"
  variable port   1883
  variable user   ""      ;# optional
  variable pass   ""      ;# optional
  variable base   "svxlink"   ;# Topic-Basis
  # DTMF
  variable prefix "77"        ;# Sicherheits-Prefix: 77 <CODE> #
  variable buf ""             ;# Eingabepuffer

  # Mapping CODE -> Topic/Payload (Beispiele anpassen!)
  array set MAP {
    11 {fhem/cmnd/cmnd_1 on}
    10 {fhem/cmnd/cmnd_1 off}
    21 {fhem/cmnd/cmnd_2 on}
    20 {fhem/cmnd/cmnd_2 off}
  }
}

proc ::MQTTBR::pub {topic payload {retain 0}} {
  variable host; variable port; variable user; variable pass
  set args [list mosquitto_pub -h $host -p $port -t $topic -m $payload -q 0]
  if {$retain} { lappend args -r }
  if {$user ne ""} { lappend args -u $user -P $pass }
  exec {*}$args &
}

# Wird pro Ziffer aus Logic aufgerufen
proc ::MQTTBR::on_dtmf {digit} {
  variable base; variable prefix; variable buf
  # Roh-Event publizieren (optional, zum Debuggen)
  set ts [clock format [clock seconds] -gmt 1 -format {%Y-%m-%dT%H:%M:%SZ}]
  catch { ::MQTTBR::pub "$base/dtmf" [format {{"digit":"%s","ts":"%s"}} $digit $ts] }

  # Eingabe sammeln / Reset bei *
  if {$digit eq "*"} { set buf ""; return }
  append buf $digit

  # Bei '#' auswerten
  if {$digit eq "#"} {
    # Nur wenn mit Prefix beginnt
    if {[string first $prefix $buf] == 0} {
      set code [string range $buf [string length $prefix] end-1]
      if {[info exists ::MQTTBR::MAP($code)]} {
        # MAP: "topic payload"
        foreach {t p} $::MQTTBR::MAP($code) {}
        catch { ::MQTTBR::pub $t $p }
        # Optional: Sprachbestätigung (falls Messages installiert)
        catch { playMsg "Core" "ok" }
      } else {
        catch { playMsg "Core" "error" }
      }
    }
    set buf ""
  }
}
