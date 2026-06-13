package wopan

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQRCodeGenerateUsesServiceImage(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/QRCode/generate" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("client-id") != defaultQRCodeClient {
			t.Fatalf("client-id = %q, want %q", r.Header.Get("client-id"), defaultQRCodeClient)
		}
		if r.Header.Get("x-yp-client-id") != defaultQRCodeClient {
			t.Fatalf("x-yp-client-id = %q, want %q", r.Header.Get("x-yp-client-id"), defaultQRCodeClient)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"meta": map[string]string{"code": "0000", "message": "ok"},
			"result": map[string]string{
				"uuid":  "uuid-1",
				"image": "iVBORw0KGgo=",
			},
		})
	}))
	t.Cleanup(api.Close)

	got, err := NewQRClient(QRConfig{APIBaseURL: api.URL + "/QRCode"}).Generate(context.Background())
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if got.UUID != "uuid-1" {
		t.Fatalf("uuid = %q, want uuid-1", got.UUID)
	}
	if got.QRImageDataURL != "data:image/png;base64,iVBORw0KGgo=" {
		t.Fatalf("qrImageDataUrl = %q, want PNG data URL", got.QRImageDataURL)
	}
	if got.ExpiresAt == "" {
		t.Fatalf("expiresAt is empty")
	}
}

func TestQRCodePollPending(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/QRCode/query" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("uuid") != "uuid-1" {
			t.Fatalf("uuid query = %q, want uuid-1", r.URL.Query().Get("uuid"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"meta": map[string]string{"code": "0000", "message": "ok"},
			"result": map[string]any{
				"state":        1,
				"token":        nil,
				"refreshToken": nil,
			},
		})
	}))
	t.Cleanup(api.Close)

	got, err := NewQRClient(QRConfig{APIBaseURL: api.URL + "/QRCode"}).Poll(context.Background(), "uuid-1")
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if got.State != 1 || got.StatusText != "等待扫码" || got.AccessToken != "" || got.RefreshToken != "" {
		t.Fatalf("status = %#v, want pending without tokens", got)
	}
}

func TestQRCodePollSuccessMapsTokenFields(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/QRCode/query" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"meta": map[string]string{"code": "0000", "message": "ok"},
			"result": map[string]any{
				"state":        3,
				"token":        "access-1",
				"refreshToken": "refresh-1",
			},
		})
	}))
	t.Cleanup(api.Close)

	got, err := NewQRClient(QRConfig{APIBaseURL: api.URL + "/QRCode"}).Poll(context.Background(), "uuid-1")
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if got.State != 3 || got.AccessToken != "access-1" || got.RefreshToken != "refresh-1" {
		t.Fatalf("status = %#v, want token and refreshToken mapped", got)
	}
}

func TestQRCodePollSuccessReportsMissingTokenKeys(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"meta": map[string]string{"code": "0000", "message": "ok"},
			"result": map[string]any{
				"state": 3,
				"user":  map[string]string{"name": "demo"},
			},
		})
	}))
	t.Cleanup(api.Close)

	_, err := NewQRClient(QRConfig{APIBaseURL: api.URL + "/QRCode"}).Poll(context.Background(), "uuid-1")
	if err == nil {
		t.Fatal("Poll() error is nil, want missing token error")
	}
	if !strings.Contains(err.Error(), "missing access_token, refresh_token") ||
		!strings.Contains(err.Error(), "available keys") {
		t.Fatalf("error = %q, want missing token keys", err.Error())
	}
}
