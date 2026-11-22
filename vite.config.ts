import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		watch: {
			ignored: ["**/src-tauri/**"]
		}
	},
	build: {
		target: "esnext",
		chunkSizeWarningLimit: 1200,
		rolldownOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("node_modules/monaco-editor")) {
						return "monaco";
					}
					if (id.includes("node_modules/react")) {
						return "react-vendor";
					}
				}
			}
		}
	}
});