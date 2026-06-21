package drives

import "testing"

func TestTextMentionsHTTPStatus(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{name: "status context", text: "request failed with status: 429 Too Many Requests", want: true},
		{name: "http context", text: "http 503 service unavailable", want: true},
		{name: "server returned context", text: "Server returned 403 Forbidden", want: true},
		{name: "message only", text: "操作频繁，请稍后重试", want: false},
		{name: "unrelated number", text: "generated 429 bytes", want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := TextMentionsHTTPStatus(tc.text, 403, 429, 503); got != tc.want {
				t.Fatalf("TextMentionsHTTPStatus(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}
