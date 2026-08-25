# PerralVPN Backend

Backend Node.js/Express/SQLite của PerralVPN. Repository này dùng để triển khai trên VPS; frontend được quản lý riêng trong repository `Perral2510/perralvpn-frontend`.

## Chạy trên VPS

```bash
git clone https://github.com/Perral2510/perralvpn-backend.git ~/perralvpn
cd ~/perralvpn
cp .env.example .env
nano .env
docker compose up -d --build
```

Backend chỉ bind trên VPS tại:

```text
127.0.0.1:3000
```

Kiểm tra:

```bash
curl -i http://127.0.0.1:3000/api/health
docker compose ps
```

## Cấu hình môi trường

Trong `.env`, đặt:

```env
NODE_ENV=production
PORT=3000
DB_PATH=/app/data/app.sqlite
FRONTEND_ORIGIN=https://app.perral.dpdns.org
ADMIN_API_KEY=replace-with-a-long-random-secret

# 3x-ui provisioning (token stays on backend only)
XUI_BASE_URL=https://panel.example.com
XUI_API_TOKEN=replace-with-an-admin-scope-3x-ui-api-token
XUI_SUB_BASE_URL=https://panel.example.com:2096
PUBLIC_API_URL=https://api.example.com
XUI_VLESS_PROFILES={"vina-khong-nen":{"address":"vnpt.theworkpc.com","port":443,"path":"/tiktok4g","security":"tls","encryption":"none","host":"perral.de5.net","fp":"chrome","type":"ws","sni":"perral.de5.net","remark":"PERRAL"}}
XUI_SUB_PATH=/sub/
XUI_JSON_PATH=/json/
XUI_CLASH_PATH=/clash/
XUI_INBOUND_IDS_BY_PLAN={"vina-khong-nen":[1]}
XUI_DEFAULT_INBOUND_IDS=
```

Không commit `.env`, SQLite hoặc khóa quản trị.

## Cloudflare Tunnel

Tạo Published Application route:

```text
Hostname: api.perral.dpdns.org
Service: http://localhost:3000
```

File mẫu `deploy/cloudflared-config.yml` không chứa token thật. Cài `cloudflared` bằng token do Cloudflare Dashboard cấp và bật service:

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared
```

## Tự khởi động

```bash
sudo cp deploy/perralvpn.service /etc/systemd/system/perralvpn.service
sudo systemctl daemon-reload
sudo systemctl enable --now perralvpn
```

Service này chỉ quản lý backend Docker; không quản lý 3x-ui/Xray hoặc Cloudflare Tunnel.

## Quên mật khẩu qua Gmail

Backend hỗ trợ gửi mã đặt lại mật khẩu qua Gmail SMTP. Dùng Google App Password, không dùng mật khẩu Gmail thông thường:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=ntlb.nhat@gmail.com
SMTP_PASS=replace-with-gmail-app-password
MAIL_FROM=PerralVPN <ntlb.nhat@gmail.com>
RESET_CODE_EXPIRES_MINUTES=10
```

Luồng API là:

```text
POST /api/auth/request-password-reset  { email }
POST /api/auth/reset-password           { email, code, newPassword }
```

Mã chỉ được lưu dưới dạng hash trong SQLite, hết hạn sau thời gian cấu hình, bị giới hạn số lần thử và được đánh dấu đã sử dụng sau khi đổi mật khẩu. Sau khi reset thành công, các session cũ của tài khoản sẽ bị thu hồi.

Không commit `.env`, App Password, database hoặc token vào repository.

## Đồng bộ client với 3x-ui

Backend gọi API của 3x-ui từ server-to-server. Sau khi admin gọi `POST /api/admin/orders/:id/mark-paid`, backend tạo hoặc cập nhật client với **email tài khoản PerralVPN** ở trường Email, **UUID ngẫu nhiên** ở trường ID bắt buộc của Xray, `subId`, quota theo `capacity`, hạn dùng theo `expires_at`, rồi attach client vào inbound IDs của gói. Luồng này có thể chạy lại an toàn; nếu client đã tồn tại, backend kiểm tra UUID/comment trước khi update để không ghi đè client ngoài PerralVPN.

Mapping gói sang inbound đặt trong `XUI_INBOUND_IDS_BY_PLAN`. Với gói hiện tại, key là `vina-khong-nen`; inbound hiện tại là ID `1` theo cấu hình đã kiểm tra. `XUI_SUB_BASE_URL` phải là origin truy cập công khai của subscription server 3x-ui; nếu dùng reverse proxy, hãy bảo đảm các path `/sub`, `/json`, `/clash` được chuyển tới subscription server và URI Path trong 3x-ui khớp với biến môi trường.

Các endpoint user mới là `GET /api/account/vpn` để lấy URL/QR hiện tại và `POST /api/account/vpn/sync` để đồng bộ lại gói đang hoạt động. Response không chứa API token hoặc mật khẩu panel; QR được sinh cục bộ bằng backend. Backend tự dựng VLESS URL theo `XUI_VLESS_PROFILES`, không dùng raw subLinks của 3x-ui. `GET /api/account/vpn/sub/:subId` là subscription text công khai, trả toàn bộ VLESS URL của group; khi thêm client vào cùng group, URL này tự trả thêm client và vẫn giữ nguyên subId.

Mỗi group có một `subId` và nhiều bản ghi client trong `vpn_subscription_clients`. Admin có thể thêm client vào group bằng `POST /api/admin/vpn-subscriptions/:subId/clients` với body `{"email":"another@example.com"}`; client mới sẽ dùng cùng profile gói và xuất hiện ngay trong custom subscription:

```bash
curl -sS -X POST https://api.example.com/api/admin/vpn-subscriptions/SUB_ID/clients \\
  -H 'Content-Type: application/json' \\
  -H 'x-admin-key: ADMIN_API_KEY_TRÊN_VPS' \\
  -d '{"email":"another@example.com"}'
```


Admin có thể cấp trực tiếp một gói cho tài khoản đã tồn tại bằng endpoint `POST /api/admin/grant-plan`. Endpoint này tạo một order audit có phương thức `admin_grant`, đánh dấu paid, hết hạn subscription cũ của user, provision client 3x-ui mới và trả thông tin subscription:

```bash
curl -sS -X POST https://api.example.com/api/admin/grant-plan \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: ADMIN_API_KEY_TRÊN_VPS' \
  -d '{"email":"facebook.tnlb@gmail.com","planSlug":"vina-khong-nen"}'
```

Không đặt `x-admin-key` trong frontend hoặc gửi nó qua chat. Response thành công có `data.vpn.subscriptionUrl`, `data.vpn.jsonUrl`, `data.vpn.clashUrl` và `data.vpn.qrDataUrl`.
