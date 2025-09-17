#
# SVXLinkWeb.pm
# FHEM-Modul zur Steuerung des SVXLink-Web-Backends.
#
package main;

use strict;
use warnings;
use LWP::UserAgent;
use JSON;

# ----------------------------------------------------------------------
# FHEM-Standardfunktionen
# ----------------------------------------------------------------------
sub SVXLinkWeb_Initialize($);
sub SVXLinkWeb_Define($$);
sub SVXLinkWeb_Undefine($$);
sub SVXLinkWeb_Set($$@);
sub SVXLinkWeb_Attr($$@);
sub SVXLinkWeb_GetHtml($);
sub SVXLinkWeb_ParseApiStatus($$$);

sub SVXLinkWeb_Initialize($) {
    my ($hash) = @_;
    
    # Registriere die Hauptfunktionen des Moduls
    $hash->{DefFn}    = "SVXLinkWeb_Define";
    $hash->{UndefFn}  = "SVXLinkWeb_Undefine";
    $hash->{SetFn}    = "SVXLinkWeb_Set";
    $hash->{AttrFn}   = "SVXLinkWeb_Attr";
    $hash->{GetFn}    = "SVXLinkWeb_GetHtml";
    
    # Exponierte FHEM-Attribute
    $hash->{AttrList} = "url ";
    
    return;
}

sub SVXLinkWeb_Define($$) {
    my ($hash, $def) = @_;
    my @a = split("[ \t][ \t]*", $def);
    
    # Syntax: define <name> SVXLinkWeb
    my $name = $a[0];
    
    # Standard-Readings
    readingsSingleUpdate($hash, "state", "defined", 1);
    
    return;
}

sub SVXLinkWeb_Undefine($$) {
    my ($hash, $name) = @_;
    
    return;
}

sub SVXLinkWeb_Set($$@) {
    my ($hash, $name, @a) = @_;
    
    my $cmd = $a[0];
    my $url = AttrVal($name, "url", undef);
    
    if (!$url) {
        return "URL-Attribut nicht definiert. Verwenden Sie `attr $name url <node-js-url>`";
    }

    my $ua = LWP::UserAgent->new;
    my $response;
    my $content_type = 'application/json';
    my $data_to_send;
    my $api_path;
    
    if ($cmd eq "restart" || $cmd eq "start" || $cmd eq "stop") {
        # Sende POST-Anfrage zum SVXLink-Service-Endpunkt
        $api_path = "api/service/$cmd";
        $response = $ua->post("$url/$api_path");
    } elsif ($cmd eq "connect") {
        my $server = $a[1];
        if (!$server) { return "Usage: set $name connect <server>"; }
        $api_path = "api/reflector/connect";
        $data_to_send = to_json({ server => $server });
        $response = $ua->post("$url/$api_path", Content_Type => $content_type, Content => $data_to_send);
    } elsif ($cmd eq "disconnect") {
        $api_path = "api/reflector/disconnect";
        $response = $ua->post("$url/$api_path");
    } elsif ($cmd eq "dtmf") {
        my $digits = $a[1];
        if (!$digits) { return "Usage: set $name dtmf <digits>"; }
        $api_path = "api/dtmf";
        $data_to_send = to_json({ digits => $digits });
        $response = $ua->post("$url/$api_path", Content_Type => $content_type, Content => $data_to_send);
    } else {
        return "Unbekannter Befehl: $cmd";
    }
    
    if ($response->is_success) {
        readingsSingleUpdate($hash, "lastCommand", $cmd, 1);
        my $response_json = decode_json($response->content);
        if ($response_json->{ok}) {
            readingsSingleUpdate($hash, "state", "Command $cmd OK", 1);
        } else {
            readingsSingleUpdate($hash, "state", "Command $cmd failed", 1);
        }
        return undef;
    } else {
        return "HTTP-Fehler bei '$cmd': " . $response->status_line;
    }
}

sub SVXLinkWeb_Attr($$@) {
    my ($hash, $name, @a) = @_;
    my $cmd = $a[0];
    my $attr = $a[1];
    
    # Speichert die Node.js-Backend-URL als Attribut
    if ($cmd eq "set" && $attr eq "url") {
        my $url = $a[2];
        if (!$url) {
            return "Fehlender Wert für Attribut 'url'";
        }
        $attr = $url;
    }
    
    return undef;
}


sub SVXLinkWeb_GetHtml($) {
    my ($hash) = @_;
    my $name = $hash->{NAME};
    my $url = AttrVal($name, "url", undef);

    if (!$url) {
        return "Bitte definieren Sie das Attribut 'url' mit dem URL Ihres Node.js-Servers.";
    }
    
    my $html_code = "";
    $html_code .= "<h4>DTMF</h4>";
    $html_code .= "<div class='dtmf-keypad'>";
    for my $i (1..9) {
        $html_code .= "<button onclick='fhem(\"set $name dtmf $i\")'>$i</button>";
    }
    $html_code .= "<button onclick='fhem(\"set $name dtmf *\")'>*</button>";
    $html_code .= "<button onclick='fhem(\"set $name dtmf 0\")'>0</button>";
    $html_code .= "<button onclick='fhem(\"set $name dtmf #\")'>#</button>";
    $html_code .= "</div>";

    return $html_code;
}

1;
