import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { SkyStarfield } from "@/components/SkyStarfield";
import { RequireAuth } from "@/admin/RequireAuth";

const HomePage = lazy(() => import("@/pages/HomePage"));
const ListingPage = lazy(() => import("@/pages/ListingPage"));
const ShortsPage = lazy(() => import("@/pages/ShortsPage"));
const UploadPage = lazy(() => import("@/pages/UploadPage"));
const VideoDetailPage = lazy(() => import("@/pages/VideoDetailPage"));

const LoginPage = lazy(() =>
  import("@/admin/LoginPage").then((module) => ({ default: module.LoginPage }))
);
const AdminLayout = lazy(() =>
  import("@/admin/AdminLayout").then((module) => ({
    default: module.AdminLayout,
  }))
);
const DrivesPage = lazy(() =>
  import("@/admin/DrivesPage").then((module) => ({ default: module.DrivesPage }))
);
const CrawlersPage = lazy(() =>
  import("@/admin/CrawlersPage").then((module) => ({
    default: module.CrawlersPage,
  }))
);
const VideosPage = lazy(() =>
  import("@/admin/VideosPage").then((module) => ({ default: module.VideosPage }))
);
const TagsPage = lazy(() =>
  import("@/admin/TagsPage").then((module) => ({ default: module.TagsPage }))
);
const ThemePage = lazy(() =>
  import("@/admin/ThemePage").then((module) => ({ default: module.ThemePage }))
);

export default function App() {
  return (
    <>
      {/* 星空蓝主题的固定位置星星层，仅在 data-theme="sky" 下可见 */}
      <SkyStarfield />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          {/* 主站需要登录 */}
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/list"
            element={
              <RequireAuth>
                <ListingPage />
              </RequireAuth>
            }
          />
          <Route
            path="/shorts"
            element={
              <RequireAuth>
                <ShortsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/upload"
            element={
              <RequireAuth>
                <UploadPage />
              </RequireAuth>
            }
          />
          <Route
            path="/video/:id"
            element={
              <RequireAuth>
                <VideoDetailPage />
              </RequireAuth>
            }
          />

          {/* 管理后台也需要登录 */}
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <AdminLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="/admin/drives" replace />} />
            <Route path="drives" element={<DrivesPage />} />
            <Route path="crawlers" element={<CrawlersPage />} />
            <Route path="videos" element={<VideosPage />} />
            <Route path="tags" element={<TagsPage />} />
            <Route path="theme" element={<ThemePage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
