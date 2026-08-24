# DucAnhVPN Backend

Backend Node.js/Express/SQLite của DucAnhVPN. Repository này dùng để triển khai trên VPS; frontend được quản lý riêng trong repository `Perral2510/ducanhvpn-frontend`.

## Chạy trên VPS

```bash
git clone https://github.com/Perral2510/ducanhvpn-backend.git ~/ducanhvpn
cd ~/ducanhvpn
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
sudo cp deploy/ducanhvpn.service /etc/systemd/system/ducanhvpn.service
sudo systemctl daemon-reload
sudo systemctl enable --now ducanhvpn
```

Service này chỉ quản lý backend Docker; không quản lý 3x-ui/Xray hoặc Cloudflare Tunnel.
