package guangyapan

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestQRClientGenerate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/device/code" {
			t.Fatalf("path = %s, want device code endpoint", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["client_id"] != defaultClientID || body["scope"] != defaultQRScope {
			t.Fatalf("body = %#v", body)
		}
		writeTestJSON(w, map[string]any{
			"device_code":               "device-1",
			"verification_uri_complete": "https://account.guangyapan.com/device?code=abc",
			"interval":                  7,
			"expires_in":                180,
		})
	}))
	defer srv.Close()

	client := NewQRClient(QRConfig{
		AccountBaseURL: srv.URL,
		Now:            func() time.Time { return time.Unix(1700000000, 0) },
	})
	session, err := client.Generate(context.Background())
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if session.DeviceCode != "device-1" || session.QRCodeURL != "https://account.guangyapan.com/device?code=abc" {
		t.Fatalf("session = %#v", session)
	}
	if session.IntervalSeconds != 7 {
		t.Fatalf("interval = %d, want 7", session.IntervalSeconds)
	}
	if session.ExpiresAt != time.Unix(1700000180, 0).Format(time.RFC3339) {
		t.Fatalf("expiresAt = %q", session.ExpiresAt)
	}
	if !strings.HasPrefix(session.QRImageDataURL, "data:image/png;base64,") {
		t.Fatalf("qr image = %q", session.QRImageDataURL)
	}
}

func TestQRClientPollPendingAndSuccess(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/token" {
			t.Fatalf("path = %s, want token endpoint", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["client_id"] != defaultClientID ||
			body["grant_type"] != deviceCodeGrantType ||
			body["device_code"] != "device-1" {
			t.Fatalf("body = %#v", body)
		}
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusBadRequest)
			writeTestJSON(w, map[string]any{"error": "authorization_pending"})
			return
		}
		writeTestJSON(w, map[string]any{
			"access_token":  "access-1",
			"refresh_token": "refresh-1",
			"token_type":    "Bearer",
			"expires_in":    7200,
		})
	}))
	defer srv.Close()

	client := NewQRClient(QRConfig{AccountBaseURL: srv.URL})
	pending, err := client.Poll(context.Background(), "device-1")
	if err != nil {
		t.Fatalf("poll pending: %v", err)
	}
	if pending.State != "pending" || pending.AccessToken != "" {
		t.Fatalf("pending = %#v", pending)
	}

	success, err := client.Poll(context.Background(), "device-1")
	if err != nil {
		t.Fatalf("poll success: %v", err)
	}
	if success.State != "success" || success.AccessToken != "access-1" || success.RefreshToken != "refresh-1" {
		t.Fatalf("success = %#v", success)
	}
}
