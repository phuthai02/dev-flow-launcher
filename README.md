# Dev Flow Launcher

Chrome Extension (Manifest V3) giúp thao tác nhanh với GitLab và Jenkins:

- mở đúng trang đăng nhập GitLab/Jenkins đã cấu hình;
- tự điền tài khoản, mật khẩu và submit form;
- dùng GitLab session cookie của Chrome để gọi API;
- hiển thị trạng thái đăng nhập và thời điểm đồng bộ gần nhất;
- tự đăng nhập lại và tự động đồng bộ project, branch và Jenkins jobs;
- lấy project và branch GitLab;
- tạo, theo dõi, merge hoặc đóng merge request ngay trong extension;
- hiển thị các commit thuộc từng merge request đang mở;
- tự tạo title `UPDATE_merge branch <source> to <target>` sau khi chọn đủ hai branch, nhưng không ghi đè title người dùng đã sửa;
- hiển thị danh sách commit của phép compare `target → source` trước khi tạo merge request;
- chỉ mở trang GitLab khi người dùng bấm **Xem GitLab**;
- lấy danh sách Jenkins job và trạng thái build gần nhất;
- hiển thị Stage View động theo pipeline của Jenkins job đang chọn và theo dõi realtime sau khi build;
- trigger build thường hoặc build có parameters.
- chặn gửi trùng thao tác tạo/merge/close merge request và Build now trong 3 giây.

## Chạy extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới thư mục này.
4. Bấm icon Dev Flow Launcher và mở tab **Settings** nằm cạnh tab **Jenkins**.
5. Nhập đầy đủ GitLab/Jenkins login URL cùng tài khoản/mật khẩu rồi lưu cấu hình.
6. Extension tự đăng nhập trong tab nền nếu session còn thiếu và tự tải lại dữ liệu.
7. Bấm icon extension để tạo merge request hoặc chạy Jenkins build.

Không cần `npm install`. Để kiểm tra source:

```powershell
npm test
npm run check
```

## Xác thực

### GitLab

Extension không cấu hình sẵn host. Người dùng phải nhập GitLab login URL kết thúc bằng `/users/sign_in`. Extension điền `user[login]` và `user[password]`, sau đó dùng GitLab session để gọi REST API. Extension ưu tiên dùng lại tab GitLab cùng host đang mở; khi chưa có tab phù hợp, Chrome tạo và giữ một tab nền để duy trì session cookie.
Khi form hỗ trợ, extension tự bật **Remember me / Keep me signed in** để Chrome có thể khôi phục session. Nếu quản trị viên GitLab/Jenkins tắt tính năng này hoặc session bị thu hồi, người dùng vẫn phải đăng nhập lại.

### Jenkins

Extension không cấu hình sẵn host. Người dùng phải nhập Jenkins login URL kết thúc bằng `/login`. Extension điền `j_username` và `j_password`. Khi trigger build, extension lấy CSRF crumb từ Jenkins rồi gửi kèm session cookie.

## Lưu ý bảo mật

- Theo cấu hình hiện tại, username/password được lưu trong `chrome.storage.local` để extension có thể tự xác thực lại khi đồng bộ.
- `chrome.storage.local` không phải kho mật khẩu được mã hóa bằng khóa người dùng. Chỉ sử dụng extension trên Chrome profile và máy tính tin cậy.
- GitLab/Jenkins session cookie do website và Chrome quản lý; extension không sao chép cookie vào storage.
- Các API dùng session được gọi same-origin trong tab GitLab/Jenkins đã đăng nhập để Chrome gửi đúng session cookie.
- Tab nền GitLab/Jenkins do extension tạo được giữ lại để tái sử dụng session và tránh phải đăng nhập lại liên tục.
- Khi session lỗi, tự đăng nhập được giới hạn tối đa một lần mỗi hai phút để tránh mở form đăng nhập liên tục.
- Chỉ cài extension trên máy/profile tin cậy.
- Nên cấu hình GitLab/Jenkins bằng HTTPS để bảo vệ credential trên mạng.
- Khi đổi GitLab/Jenkins host, Chrome sẽ hỏi quyền truy cập host mới.
- Extension chỉ inject hàm điền form vào hai host được người dùng cấp quyền và không tải JavaScript từ bên ngoài.

## Giới hạn MVP

- Jenkins duyệt job trong folder nhiều cấp và hiển thị đường dẫn đầy đủ để tìm kiếm, ví dụ `Team/job/Service/job/Deploy`.
- Chưa có mapping cố định giữa GitLab project và Jenkins job.
- Jenkins session hết hạn sẽ yêu cầu người dùng đăng nhập lại.
- Nếu GitLab bật 2FA hoặc chuyển sang Azure SSO, người dùng phải hoàn tất bước đó trên tab đăng nhập.
- Extension không sử dụng GitLab Personal Access Token hoặc Jenkins API token.
