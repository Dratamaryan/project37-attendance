// Bundled at build time (static import) — not read via fs at request time.
// Vercel's output file tracing can't reliably resolve fs.readFile() calls behind a
// templated/dynamic path (`privacy-policy.${locale}.md`), which risks a missing-file
// 500 on a fresh deploy. A plain TS module sidesteps tracing entirely: any bundler that
// can resolve a normal `import` bundles this string with zero extra config.
// Source of truth: docs/privacy-policy.{id,en}.md (verbatim copy — do not reword).
export const privacyPolicyId = `# Kebijakan Privasi

*Berlaku sejak: 30 Oktober 2026 · Versi: v2*

Kebijakan Privasi ini menjelaskan data pribadi apa yang kami kumpulkan, mengapa kami mengumpulkannya, bagaimana kami menjaganya, dan apa saja hak Anda atas data tersebut. Kami menghormati kepercayaan yang Anda berikan dan berkomitmen untuk hanya menggunakan data Anda demi kepentingan komunitas.

## 1. Siapa Kami

Aplikasi ini dikelola oleh pengurus komunitas **Project 37** ("kami") untuk mencatat kehadiran, mengelola data anggota komunitas, dan menerima konfirmasi kehadiran (RSVP) untuk acara komunitas. Untuk pertanyaan apa pun mengenai privasi atau data Anda, hubungi kami di **project37events@gmail.com**.

## 2. Ruang Lingkup

Kebijakan ini berlaku bagi:

- seluruh anggota komunitas yang datanya tercatat dalam aplikasi;
- siapa pun yang mengisi formulir konfirmasi kehadiran (RSVP) melalui tautan acara, termasuk yang belum menjadi anggota komunitas;
- pengurus dan relawan yang memiliki akun untuk mengelola aplikasi.

## 3. Data yang Kami Kumpulkan

Kami hanya mengumpulkan data yang diperlukan untuk melayani komunitas, antara lain:

- **Identitas dasar:** nama lengkap, nama panggilan, jenis kelamin, tempat & tanggal lahir.
- **Kontak:** nomor telepon dan alamat email (bila tersedia).
- **Informasi komunitas:** paroki asal, status pernikahan, wilayah tempat tinggal, serta peran dan kelompok Anda di dalam komunitas.
- **Foto:** foto profil Anda, hanya bila Anda memberikannya.
- **Catatan kehadiran:** waktu dan acara saat Anda hadir.
- **Data keluarga (bila relevan):** informasi pasangan atau anak, hanya bila Anda memberikannya.
- **Konfirmasi kehadiran (RSVP):** nomor HP/WhatsApp, nama, konfirmasi kehadiran Anda, jumlah anak yang ikut, serta pilihan Anda untuk dihubungi kembali.

Bila nomor HP yang Anda isi pada formulir RSVP sudah tercatat sebagai anggota, konfirmasi Anda otomatis dikaitkan dengan data anggota tersebut. Dalam hal itu, nama yang Anda ketik tidak disimpan, dan data anggota Anda tidak diubah oleh formulir RSVP.

Bagi pengurus/relawan yang memiliki akun, kami juga mencatat aktivitas akun (misalnya waktu masuk dan tindakan yang dilakukan) untuk keperluan keamanan.

Saat Anda membuka formulir RSVP, sejumlah data teknis juga diproses untuk keamanan formulir (lihat Bagian 7).

## 4. Mengapa Kami Mengumpulkannya

Data Anda digunakan semata-mata untuk kepentingan komunitas, yaitu:

- mencatat dan mengelola kehadiran di acara komunitas;
- memelihara basis data anggota agar tetap akurat;
- mengirim undangan acara dan pengingat (misalnya ucapan ulang tahun);
- memperkirakan jumlah peserta dan menyiapkan acara berdasarkan konfirmasi kehadiran (RSVP);
- menghubungi Anda tentang kegiatan berikutnya. Khusus untuk RSVP, hal ini hanya kami lakukan bila Anda mencentang pilihan untuk dihubungi kembali;
- menjaga formulir RSVP dari spam dan penyalahgunaan;
- menyusun statistik kehadiran secara ringkas untuk keperluan pelayanan.

Kami **tidak** menjual data Anda, **tidak** menggunakannya untuk iklan, dan **tidak** membagikannya untuk tujuan komersial apa pun.

## 5. Dasar Penggunaan & Persetujuan

Kami mengolah data Anda berdasarkan persetujuan Anda dan demi kepentingan sah komunitas. Anda dapat menarik persetujuan kapan saja (lihat Bagian 8).

Pilihan untuk dihubungi kembali pada formulir RSVP bersifat sukarela dan berlaku untuk setiap pengisian. Tanpa centang tersebut, kami tidak akan menghubungi Anda berdasarkan RSVP itu.

## 6. Foto

Foto Anda hanya akan ditampilkan atau dipublikasikan bila Anda telah memberikan persetujuan. Bila Anda belum memberikan persetujuan, foto Anda tidak akan dipublikasikan. Anda dapat mengubah pilihan ini kapan saja dengan menghubungi kami.

## 7. Berbagi Data

Kami tidak membagikan data pribadi Anda kepada pihak luar, kecuali kepada penyedia layanan teknologi tepercaya yang membantu kami menjalankan aplikasi. Penyedia ini hanya boleh mengolah data sesuai instruksi kami:

- **Supabase:** basis data, autentikasi, dan penyimpanan foto (server di Singapura).
- **Vercel:** hosting aplikasi (server di Singapura).
- **Google:** pengiriman email (Gmail) dan penyimpanan cadangan data (Google Drive).
- **GitHub:** menjalankan proses pencadangan data secara otomatis.
- **Telegram:** notifikasi internal untuk tim pengurus, misalnya daftar ulang tahun dan ringkasan kehadiran yang memuat nama.
- **Cloudflare:** perlindungan formulir RSVP dari bot (lihat di bawah).

Sebagian layanan tersebut menyimpan data pada server yang berada di luar Indonesia dengan pengamanan yang memadai. Kami hanya akan mengungkapkan data bila diwajibkan oleh hukum.

**Perlindungan formulir RSVP (Cloudflare Turnstile).** Untuk mencegah spam, formulir RSVP menggunakan Cloudflare Turnstile. Saat formulir dibuka, Turnstile memproses sinyal teknis seperti alamat IP, sidik jari TLS, jenis browser (user-agent), serta situs yang Anda buka, untuk membedakan manusia dari bot. Turnstile tidak dimaksudkan untuk mengidentifikasi atau memprofilkan Anda. Untuk perlindungan ini, Cloudflare bertindak sebagai prosesor data atas nama kami. Cloudflare juga menggunakan sinyal tersebut untuk meningkatkan kemampuan deteksi bot Turnstile, dan untuk tujuan itu Cloudflare bertindak sebagai pengendali data tersendiri. Selengkapnya dapat dibaca di [Turnstile Privacy Addendum dari Cloudflare](https://www.cloudflare.com/turnstile-privacy-policy/).

Selain itu, server kami membaca alamat IP Anda sesaat untuk membatasi pengiriman formulir yang berlebihan. Alamat IP tersebut langsung diubah menjadi kode acak (hash), hanya disimpan di memori server paling lama 10 menit, dan tidak pernah dicatat atau disimpan secara permanen.

## 8. Hak Anda

Sesuai dengan Undang-Undang No. 27 Tahun 2022 tentang Pelindungan Data Pribadi, Anda berhak untuk:

- mengetahui data apa yang kami simpan dan mengapa;
- meminta salinan data Anda;
- memperbaiki data yang tidak akurat;
- meminta data Anda dihapus atau dianonimkan;
- menarik persetujuan Anda;
- menolak atau membatasi penggunaan data Anda.

Hak-hak ini juga berlaku untuk data RSVP. Bila Anda memintanya, nomor HP dan nama pada RSVP Anda akan kami anonimkan lebih awal.

Untuk menggunakan hak-hak ini, hubungi **project37events@gmail.com**. Kami akan menanggapi dalam waktu yang wajar.

## 9. Berapa Lama Kami Menyimpan Data

- **Data anggota:** kami simpan selama Anda menjadi bagian dari komunitas. Bila Anda memintanya, atau bila Anda tidak lagi aktif, kami akan menganonimkan data Anda. Identitas pribadi Anda dihapus, sementara catatan kehadiran tetap tersimpan dalam bentuk anonim untuk keperluan statistik komunitas.
- **Data RSVP:** nomor HP dan nama pada RSVP dianonimkan secara otomatis 90 hari setelah acara selesai. Jawaban kehadiran dan jumlah anak tetap tersimpan dalam bentuk anonim untuk statistik acara.
- **Alamat IP untuk pembatasan formulir:** paling lama 10 menit, hanya di memori server (lihat Bagian 7).
- **Cadangan data:** salinan cadangan basis data disimpan paling lama sekitar satu tahun, lalu dihapus. Data yang sudah dianonimkan masih dapat tersimpan di cadangan lama sampai cadangan tersebut terhapus.

## 10. Data Anak

Sebagian anggota komunitas mungkin berusia di bawah 18 tahun. Data anak hanya kami kumpulkan dan olah dengan persetujuan orang tua atau wali. Orang tua/wali dapat menghubungi kami kapan saja untuk mengakses, memperbaiki, atau menghapus data anak mereka.

Pada formulir RSVP, kami hanya menanyakan jumlah anak yang ikut, tanpa nama atau data lain tentang anak.

## 11. Keamanan

Kami menerapkan langkah pengamanan yang wajar untuk melindungi data Anda, termasuk pembatasan akses hanya kepada pengurus yang berwenang. Meski demikian, tidak ada sistem yang sepenuhnya bebas risiko; kami akan selalu berupaya sebaik mungkin menjaga data Anda.

## 12. Perubahan Kebijakan

Kami dapat memperbarui Kebijakan Privasi ini dari waktu ke waktu. Setiap perubahan akan ditandai dengan tanggal berlaku dan nomor versi yang baru pada halaman ini.

## 13. Hubungi Kami

Untuk pertanyaan, permintaan, atau keluhan terkait privasi, hubungi:

**project37events@gmail.com**` as const
