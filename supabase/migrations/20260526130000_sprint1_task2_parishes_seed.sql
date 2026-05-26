-- Migration: sprint1_task2_parishes_seed
-- Seeds all Keuskupan Agung Jakarta (KAJ) parishes across Jabodetabek
-- plus well-known Bogor and Depok parishes (Keuskupan Bogor).
-- Source: https://id.wikipedia.org/wiki/Daftar_paroki_di_Keuskupan_Agung_Jakarta
-- All rows: status='approved'. ON CONFLICT DO NOTHING — idempotent.

INSERT INTO parishes (name, city, region, status) VALUES

-- ── Dekanat Jakarta Pusat (7) ─────────────────────────────────
('Paroki Hati Kudus Yesus, Kramat',               'Jakarta', 'Jakarta Pusat',       'approved'),
('Paroki Katedral Jakarta',                        'Jakarta', 'Jakarta Pusat',       'approved'),
('Paroki Santa Theresia, Menteng',                 'Jakarta', 'Jakarta Pusat',       'approved'),
('Paroki Cempaka Putih',                           'Jakarta', 'Jakarta Pusat',       'approved'),
('Paroki Ekspatriat',                              'Jakarta', 'Jakarta Pusat',       'approved'),
('Paroki Jalan Malang',                            'Jakarta', 'Jakarta Pusat',       'approved'),
('Paroki Pejompongan',                             'Jakarta', 'Jakarta Pusat',       'approved'),

-- ── Dekanat Jakarta Barat I (6) ───────────────────────────────
('Paroki Cideng',                                  'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Kampung Duri',                            'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Kemakmuran',                              'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Mangga Besar',                            'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Santo Ignatius, Slipi',                   'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Santa Maria de Fatima, Toasebio',         'Jakarta', 'Jakarta Barat',       'approved'),

-- ── Dekanat Jakarta Barat II (9) ──────────────────────────────
('Paroki Bojong Indah',                            'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Trinitas, Cengkareng',                    'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Santo Kristoforus, Grogol',               'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Kalideres',                               'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Kapuk',                                   'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Kedoya',                                  'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Kosambi Baru',                            'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Meruya',                                  'Jakarta', 'Jakarta Barat',       'approved'),
('Paroki Tomang',                                  'Jakarta', 'Jakarta Barat',       'approved'),

-- ── Dekanat Jakarta Selatan (6) ───────────────────────────────
('Paroki Blok B',                                  'Jakarta', 'Jakarta Selatan',     'approved'),
('Paroki Blok Q',                                  'Jakarta', 'Jakarta Selatan',     'approved'),
('Paroki Santo Stefanus, Cilandak',                'Jakarta', 'Jakarta Selatan',     'approved'),
('Paroki Jagakarsa',                               'Jakarta', 'Jakarta Selatan',     'approved'),
('Paroki Pasar Minggu',                            'Jakarta', 'Jakarta Selatan',     'approved'),
('Paroki Santo Fransiskus Asisi, Tebet',           'Jakarta', 'Jakarta Selatan',     'approved'),

-- ── Dekanat Jakarta Utara (9) ─────────────────────────────────
('Paroki Hati Santa Perawan Maria, Cilincing',     'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Danau Sunter',                            'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Santo Yakobus, Kelapa Gading',            'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Santo Yohanes Penginjil, Pademangan',     'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Regina Caeli, Pantai Indah Kapuk',        'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Gembala Yang Baik, Pluit',                'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Puspa Gading',                            'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Sunter',                                  'Jakarta', 'Jakarta Utara',       'approved'),
('Paroki Tanjung Priok',                           'Jakarta', 'Jakarta Utara',       'approved'),

-- ── Dekanat Jakarta Timur (10) ────────────────────────────────
('Paroki Bidaracina',                              'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Santo Thomas Rasul, Cijantung',           'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Cilangkap',                               'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Cililitan',                               'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Santa Anna, Duren Sawit',                 'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Halim Perdanakusuma',                     'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Santo Yosef, Matraman',                   'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Pulo Gebang',                             'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Pulomas',                                 'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Rawamangun',                              'Jakarta', 'Jakarta Timur',       'approved'),

-- ── Dekanat Tangerang I (6) ───────────────────────────────────
('Paroki Citra Raya',                              'Tangerang', 'Kabupaten Tangerang', 'approved'),
('Paroki Curug',                                   'Tangerang', 'Kabupaten Tangerang', 'approved'),
('Paroki Karawaci',                                'Tangerang', 'Tangerang Kota',     'approved'),
('Paroki Kutabumi',                                'Tangerang', 'Kabupaten Tangerang', 'approved'),
('Paroki Pinang',                                  'Tangerang', 'Tangerang Kota',     'approved'),
('Paroki Santa Maria Immaculata, Tangerang',       'Tangerang', 'Tangerang Kota',     'approved'),

-- ── Dekanat Tangerang II (7) ──────────────────────────────────
('Paroki Santo Laurensius, Alam Sutera',           'Tangerang Selatan', 'Tangerang Selatan', 'approved'),
('Paroki Bintaro',                                 'Tangerang Selatan', 'Tangerang Selatan', 'approved'),
('Paroki Bintaro Jaya',                            'Tangerang Selatan', 'Tangerang Selatan', 'approved'),
('Paroki Ciputat',                                 'Tangerang Selatan', 'Tangerang Selatan', 'approved'),
('Paroki Pamulang',                                'Tangerang Selatan', 'Tangerang Selatan', 'approved'),
('Paroki Serpong',                                 'Tangerang Selatan', 'Tangerang Selatan', 'approved'),
('Paroki Villa Melati Mas',                        'Tangerang Selatan', 'Tangerang Selatan', 'approved'),

-- ── Dekanat Bekasi (10) ───────────────────────────────────────
-- Jatiwaringin and Lubang Buaya are in the Bekasi deanery but
-- geographically located in Jakarta Timur per Wikipedia.
('Paroki Bekasi',                                  'Bekasi', 'Bekasi Kota',          'approved'),
('Paroki Bekasi Utara',                            'Bekasi', 'Bekasi Kota',          'approved'),
('Paroki Cikarang',                                'Bekasi', 'Kabupaten Bekasi',     'approved'),
('Paroki Harapan Indah',                           'Bekasi', 'Bekasi Kota',          'approved'),
('Paroki Jatiwaringin',                            'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Santo Bartolomeus, Kampung Sawah',        'Bekasi', 'Bekasi Kota',          'approved'),
('Paroki Kranggan',                                'Bekasi', 'Bekasi Kota',          'approved'),
('Paroki Kranji',                                  'Bekasi', 'Bekasi Kota',          'approved'),
('Paroki Lubang Buaya',                            'Jakarta', 'Jakarta Timur',       'approved'),
('Paroki Taman Galaxi',                            'Bekasi', 'Bekasi Kota',          'approved'),

-- ── Keuskupan Bogor — Bogor Kota (2) ─────────────────────────
('Paroki Santo Yusup, Bogor',                      'Bogor',  'Bogor Kota',           'approved'),
('Paroki Regina Pacis, Bogor',                     'Bogor',  'Bogor Kota',           'approved'),

-- ── Keuskupan Bogor — Depok (1) ───────────────────────────────
('Paroki Santo Ignatius, Depok',                   'Depok',  'Depok',                'approved')

ON CONFLICT (name) DO NOTHING;
