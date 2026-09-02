#!/usr/bin/env sh
set -eu

die() {
	printf 'norn install: %s\n' "$*" >&2
	exit 1
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

repository="${NORN_REPOSITORY:-vimhead/norn}"
release_tag="${NORN_RELEASE_TAG:-tip}"
binary_name="${NORN_BINARY_NAME:-norn}"
base_url="${NORN_RELEASE_BASE_URL:-https://github.com/$repository/releases/download/$release_tag}"

if [ -n "${NORN_INSTALL_DIR:-}" ]; then
	install_dir="$NORN_INSTALL_DIR"
else
	[ -n "${HOME:-}" ] || die "HOME is required when NORN_INSTALL_DIR is unset"
	install_dir="$HOME/.local/bin"
fi

detect_asset_name() {
	os="$(uname -s)"
	machine="$(uname -m)"
	case "$os" in
		Darwin) platform="darwin" ;;
		Linux) platform="linux" ;;
		MINGW*|MSYS*|CYGWIN*) platform="windows" ;;
		*) die "unsupported operating system: $os" ;;
	esac
	case "$machine" in
		x86_64|amd64) arch="x64" ;;
		aarch64|arm64) arch="arm64" ;;
		*) die "unsupported architecture: $machine" ;;
	esac
	if [ "$platform" = "windows" ]; then
		printf 'norn-%s-%s.exe' "$platform" "$arch"
	else
		printf 'norn-%s-%s' "$platform" "$arch"
	fi
}

download_file() {
	url="$1"
	output="$2"
	if command_exists curl; then
		curl -fsSL "$url" -o "$output"
	elif command_exists wget; then
		wget -qO "$output" "$url"
	else
		die "curl or wget is required"
	fi
}

sha256_file() {
	file="$1"
	if command_exists sha256sum; then
		sha256sum "$file" | awk '{ print $1 }'
	elif command_exists shasum; then
		shasum -a 256 "$file" | awk '{ print $1 }'
	else
		die "sha256sum or shasum is required"
	fi
}

verify_checksum() {
	file="$1"
	checksum_file="$2"
	expected="$(awk '{ print $1 }' "$checksum_file")"
	actual="$(sha256_file "$file")"
	[ -n "$expected" ] || die "empty checksum"
	[ "$actual" = "$expected" ] || die "checksum mismatch for $file"
}

install_binary() {
	source_path="$1"
	target_path="$install_dir/$binary_name"
	mkdir -p "$install_dir"
	temporary_target="$install_dir/.norn-install-$$"
	cp "$source_path" "$temporary_target"
	chmod 0755 "$temporary_target"
	mv "$temporary_target" "$target_path"
	printf 'norn installed to %s\n' "$target_path"
	case ":$PATH:" in
		*:"$install_dir":*) ;;
		*) printf 'add %s to PATH if norn is not found\n' "$install_dir" ;;
	esac
}

temp_dir="$(mktemp -d)"
cleanup() {
	rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

asset_name="$(detect_asset_name)"
binary_path="$temp_dir/$asset_name"
checksum_path="$temp_dir/$asset_name.sha256"

download_file "$base_url/$asset_name" "$binary_path"
download_file "$base_url/$asset_name.sha256" "$checksum_path"
verify_checksum "$binary_path" "$checksum_path"
install_binary "$binary_path"
