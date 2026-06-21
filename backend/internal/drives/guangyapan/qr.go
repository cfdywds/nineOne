package guangyapan

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-resty/resty/v2"
	"github.com/skip2/go-qrcode"
)

const (
	defaultQRScope      = "user"
	deviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code"
	defaultQRUserAgent  = "GuangYaPan-Login/1.0"
)

type QRConfig struct {
	AccountBaseURL string
	HTTPClient     *http.Client
	Now            func() time.Time
}

type QRClient struct {
	accountBaseURL string
	client         *resty.Client
	now            func() time.Time
}

type QRCodeSession struct {
	DeviceCode      string `json:"deviceCode"`
	QRCodeURL       string `json:"qrCodeUrl"`
	QRImageDataURL  string `json:"qrImageDataUrl"`
	IntervalSeconds int    `json:"intervalSeconds"`
	ExpiresAt       string `json:"expiresAt,omitempty"`
}

type QRCodeStatus struct {
	State           string `json:"state"`
	StatusText      string `json:"statusText"`
	IntervalSeconds int    `json:"intervalSeconds,omitempty"`
	AccessToken     string `json:"accessToken,omitempty"`
	RefreshToken    string `json:"refreshToken,omitempty"`
	TokenType       string `json:"tokenType,omitempty"`
	ExpiresIn       int64  `json:"expiresIn,omitempty"`
}

type deviceCodeResp struct {
	DeviceCode              string `json:"device_code"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ShortURIComplete        string `json:"short_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
	Error                   string `json:"error"`
	ErrorCode               int    `json:"error_code"`
	ErrorDesc               string `json:"error_description"`
}

type deviceTokenResp struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorCode    int    `json:"error_code"`
	ErrorDesc    string `json:"error_description"`
}

func NewQRClient(c QRConfig) *QRClient {
	accountBaseURL := strings.TrimRight(strings.TrimSpace(c.AccountBaseURL), "/")
	if accountBaseURL == "" {
		accountBaseURL = defaultAccountBaseURL
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	now := c.Now
	if now == nil {
		now = time.Now
	}
	return &QRClient{
		accountBaseURL: accountBaseURL,
		client: resty.NewWithClient(httpClient).
			SetTimeout(20*time.Second).
			SetBaseURL(accountBaseURL).
			SetHeader("User-Agent", defaultQRUserAgent).
			SetHeader("Accept", "application/json").
			SetHeader("Content-Type", "application/json"),
		now: now,
	}
}

func (c *QRClient) Generate(ctx context.Context) (QRCodeSession, error) {
	var out deviceCodeResp
	var errOut deviceCodeResp
	resp, err := c.client.R().
		SetContext(ctx).
		SetBody(map[string]any{
			"client_id": defaultClientID,
			"scope":     defaultQRScope,
		}).
		SetResult(&out).
		SetError(&errOut).
		Post("/v1/auth/device/code")
	if err != nil {
		return QRCodeSession{}, err
	}
	if resp.IsError() || out.Error != "" {
		if out.Error == "" {
			out = errOut
		}
		return QRCodeSession{}, fmt.Errorf("guangyapan qr: %s", deviceAPIError(out.ErrorDesc, out.Error, resp))
	}

	deviceCode := strings.TrimSpace(out.DeviceCode)
	if deviceCode == "" {
		return QRCodeSession{}, errors.New("guangyapan qr: empty device_code")
	}
	qrURL := strings.TrimSpace(out.VerificationURIComplete)
	if qrURL == "" {
		qrURL = strings.TrimSpace(out.ShortURIComplete)
	}
	if qrURL == "" {
		return QRCodeSession{}, errors.New("guangyapan qr: empty verification uri")
	}
	interval := out.Interval
	if interval <= 0 {
		interval = 5
	}
	expiresIn := out.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 300
	}
	png, err := qrcode.Encode(qrURL, qrcode.Medium, 220)
	if err != nil {
		return QRCodeSession{}, err
	}
	return QRCodeSession{
		DeviceCode:      deviceCode,
		QRCodeURL:       qrURL,
		QRImageDataURL:  "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
		IntervalSeconds: interval,
		ExpiresAt:       c.now().Add(time.Duration(expiresIn) * time.Second).Format(time.RFC3339),
	}, nil
}

func (c *QRClient) Poll(ctx context.Context, deviceCode string) (QRCodeStatus, error) {
	deviceCode = strings.TrimSpace(deviceCode)
	if deviceCode == "" {
		return QRCodeStatus{}, errors.New("deviceCode is required")
	}

	var out deviceTokenResp
	var errOut deviceTokenResp
	resp, err := c.client.R().
		SetContext(ctx).
		SetBody(map[string]any{
			"client_id":   defaultClientID,
			"grant_type":  deviceCodeGrantType,
			"device_code": deviceCode,
		}).
		SetResult(&out).
		SetError(&errOut).
		Post("/v1/auth/token")
	if err != nil {
		return QRCodeStatus{}, err
	}
	if resp.IsError() && out.Error == "" {
		out = errOut
	}
	if resp.IsError() && out.Error == "" {
		_ = json.Unmarshal(resp.Body(), &out)
	}
	if out.Error != "" {
		return qrStatusForDeviceError(out), nil
	}
	if resp.IsError() {
		return QRCodeStatus{}, fmt.Errorf("guangyapan qr: status=%d body=%s", resp.StatusCode(), resp.String())
	}
	access := strings.TrimSpace(out.AccessToken)
	refresh := strings.TrimSpace(out.RefreshToken)
	if access == "" || refresh == "" {
		return QRCodeStatus{}, errors.New("guangyapan qr: login succeeded but token response is incomplete")
	}
	tokenType := strings.TrimSpace(out.TokenType)
	if tokenType == "" {
		tokenType = "Bearer"
	}
	return QRCodeStatus{
		State:        "success",
		StatusText:   "登录成功",
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    tokenType,
		ExpiresIn:    out.ExpiresIn,
	}, nil
}

func qrStatusForDeviceError(out deviceTokenResp) QRCodeStatus {
	errCode := strings.TrimSpace(out.Error)
	switch errCode {
	case "authorization_pending":
		return QRCodeStatus{State: "pending", StatusText: "等待扫码确认"}
	case "slow_down":
		return QRCodeStatus{State: "pending", StatusText: "等待扫码确认，已降低查询频率", IntervalSeconds: 10}
	case "expired_token":
		return QRCodeStatus{State: "expired", StatusText: "二维码已过期"}
	case "access_denied":
		return QRCodeStatus{State: "denied", StatusText: "用户拒绝了授权"}
	default:
		msg := strings.TrimSpace(out.ErrorDesc)
		if msg == "" {
			msg = errCode
		}
		if msg == "" {
			msg = "未知错误"
		}
		return QRCodeStatus{State: "error", StatusText: msg}
	}
}

func deviceAPIError(desc, short string, resp *resty.Response) string {
	msg := strings.TrimSpace(desc)
	if msg == "" {
		msg = strings.TrimSpace(short)
	}
	if msg == "" && resp != nil {
		msg = strings.TrimSpace(resp.String())
	}
	if msg == "" && resp != nil {
		msg = fmt.Sprintf("status=%d", resp.StatusCode())
	}
	if msg == "" {
		msg = "unknown error"
	}
	return msg
}
