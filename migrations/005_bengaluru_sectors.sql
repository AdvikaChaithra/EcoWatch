-- 005: Pre-divide Bengaluru into sectors.
-- Each sector is a real locality, centred on its OpenStreetMap coordinates (Nominatim, Oct 2026),
-- grouped by its Greater Bengaluru Authority city corporation (also read from OpenStreetMap).
-- Initial owners: Central/North/East -> sunitha@bbmp.gov.in, South/West/ELCITA -> admin@bbmp.gov.in.
-- The super admin can reassign any sector afterwards; existing sectors are left untouched.

alter table public.sectors add column if not exists corporation text;
create index if not exists idx_sectors_corporation on public.sectors (corporation);

update public.sectors set corporation = 'Bengaluru Central City Corporation' where id like 'SEC-IND-%' and corporation is null;
update public.sectors set corporation = 'Bengaluru South City Corporation'   where id like 'SEC-KOR-%' and corporation is null;
update public.sectors set corporation = 'Bengaluru West City Corporation'    where id like 'SEC-BHN-%' and corporation is null;

insert into public.sectors (id, area, name, corporation, lat, lng, admin_id, active)
select v.id, v.area, v.name, v.corporation, v.lat, v.lng, a.id, true
from (values
  ('SEC-SHV-1', 'Shivajinagar', 'Sector 1', 'Bengaluru Central City Corporation', 12.985529, 77.60545, 'sunitha@bbmp.gov.in'),
  ('SEC-FRZ-1', 'Frazer Town', 'Sector 1', 'Bengaluru North City Corporation', 12.997585, 77.613674, 'sunitha@bbmp.gov.in'),
  ('SEC-HAL-1', 'Halasuru', 'Sector 1', 'Bengaluru Central City Corporation', 12.977879, 77.62467, 'sunitha@bbmp.gov.in'),
  ('SEC-CVR-1', 'C V Raman Nagar', 'Sector 1', 'Bengaluru Central City Corporation', 12.985648, 77.664977, 'sunitha@bbmp.gov.in'),
  ('SEC-BAN-1', 'Banaswadi', 'Sector 1', 'Bengaluru North City Corporation', 13.014162, 77.651854, 'sunitha@bbmp.gov.in'),
  ('SEC-RTN-1', 'R T Nagar', 'Sector 1', 'Bengaluru North City Corporation', 13.025416, 77.596007, 'sunitha@bbmp.gov.in'),
  ('SEC-MAL-1', 'Malleshwaram', 'Sector 1', 'Bengaluru West City Corporation', 13.002735, 77.570325, 'admin@bbmp.gov.in'),
  ('SEC-RAJ-1', 'Rajajinagar', 'Sector 1', 'Bengaluru West City Corporation', 13.000536, 77.5497, 'admin@bbmp.gov.in'),
  ('SEC-BSV-1', 'Basaveshwaranagar', 'Sector 1', 'Bengaluru West City Corporation', 12.993757, 77.539132, 'admin@bbmp.gov.in'),
  ('SEC-VIJ-1', 'Vijayanagar', 'Sector 1', 'Bengaluru West City Corporation', 12.970954, 77.537385, 'admin@bbmp.gov.in'),
  ('SEC-CHM-1', 'Chamrajpet', 'Sector 1', 'Bengaluru Central City Corporation', 12.958418, 77.562916, 'sunitha@bbmp.gov.in'),
  ('SEC-GAN-1', 'Gandhinagar', 'Sector 1', 'Bengaluru Central City Corporation', 12.977153, 77.580031, 'sunitha@bbmp.gov.in'),
  ('SEC-JAY-1', 'Jayanagar', 'Sector 1', 'Bengaluru South City Corporation', 12.929273, 77.582423, 'admin@bbmp.gov.in'),
  ('SEC-BSG-1', 'Basavanagudi', 'Sector 1', 'Bengaluru Central City Corporation', 12.941726, 77.575502, 'sunitha@bbmp.gov.in'),
  ('SEC-JPN-1', 'J P Nagar', 'Sector 1', 'Bengaluru South City Corporation', 12.910954, 77.59782, 'admin@bbmp.gov.in'),
  ('SEC-BSK-1', 'Banashankari', 'Sector 1', 'Bengaluru West City Corporation', 12.92782, 77.556621, 'admin@bbmp.gov.in'),
  ('SEC-WIL-1', 'Wilson Garden', 'Sector 1', 'Bengaluru Central City Corporation', 12.948934, 77.596827, 'sunitha@bbmp.gov.in'),
  ('SEC-PAD-1', 'Padmanabhanagar', 'Sector 1', 'Bengaluru South City Corporation', 12.918102, 77.557664, 'admin@bbmp.gov.in'),
  ('SEC-HSR-1', 'HSR Layout', 'Sector 1', 'Bengaluru South City Corporation', 12.911623, 77.638862, 'admin@bbmp.gov.in'),
  ('SEC-BTM-1', 'BTM Layout', 'Sector 1', 'Bengaluru South City Corporation', 12.914001, 77.610282, 'admin@bbmp.gov.in'),
  ('SEC-BOM-1', 'Bommanahalli', 'Sector 1', 'Bengaluru South City Corporation', 12.903458, 77.623003, 'admin@bbmp.gov.in'),
  ('SEC-ELC-1', 'Electronic City', 'Sector 1', 'Electronic City Industrial Township', 12.84876, 77.648253, 'admin@bbmp.gov.in'),
  ('SEC-BEG-1', 'Begur', 'Sector 1', 'Bengaluru South City Corporation', 12.863389, 77.613011, 'admin@bbmp.gov.in'),
  ('SEC-ARE-1', 'Arekere', 'Sector 1', 'Bengaluru South City Corporation', 12.887209, 77.596049, 'admin@bbmp.gov.in'),
  ('SEC-WFD-1', 'Whitefield', 'Sector 1', 'Bengaluru East City Corporation', 12.995743, 77.757949, 'sunitha@bbmp.gov.in'),
  ('SEC-MRT-1', 'Marathahalli', 'Sector 1', 'Bengaluru East City Corporation', 12.955257, 77.698416, 'sunitha@bbmp.gov.in'),
  ('SEC-KRP-1', 'Krishnarajapuram', 'Sector 1', 'Bengaluru East City Corporation', 13.000546, 77.675456, 'sunitha@bbmp.gov.in'),
  ('SEC-BEL-1', 'Bellandur', 'Sector 1', 'Bengaluru East City Corporation', 12.932049, 77.684292, 'sunitha@bbmp.gov.in'),
  ('SEC-MDP-1', 'Mahadevapura', 'Sector 1', 'Bengaluru East City Corporation', 12.996545, 77.692718, 'sunitha@bbmp.gov.in'),
  ('SEC-VAR-1', 'Varthur', 'Sector 1', 'Bengaluru East City Corporation', 12.940651, 77.746988, 'sunitha@bbmp.gov.in'),
  ('SEC-YEL-1', 'Yelahanka', 'Sector 1', 'Bengaluru North City Corporation', 13.100698, 77.596345, 'sunitha@bbmp.gov.in'),
  ('SEC-JAK-1', 'Jakkur', 'Sector 1', 'Bengaluru North City Corporation', 13.078474, 77.606894, 'sunitha@bbmp.gov.in'),
  ('SEC-VID-1', 'Vidyaranyapura', 'Sector 1', 'Bengaluru North City Corporation', 13.076641, 77.557732, 'sunitha@bbmp.gov.in'),
  ('SEC-THN-1', 'Thanisandra', 'Sector 1', 'Bengaluru North City Corporation', 13.05225, 77.631615, 'sunitha@bbmp.gov.in'),
  ('SEC-BYT-1', 'Byatarayanapura', 'Sector 1', 'Bengaluru North City Corporation', 13.068322, 77.591006, 'sunitha@bbmp.gov.in'),
  ('SEC-PEN-1', 'Peenya', 'Sector 1', 'Bengaluru West City Corporation', 13.033051, 77.533223, 'admin@bbmp.gov.in'),
  ('SEC-JAL-1', 'Jalahalli', 'Sector 1', 'Bengaluru West City Corporation', 13.03941, 77.519735, 'admin@bbmp.gov.in'),
  ('SEC-TDS-1', 'T Dasarahalli', 'Sector 1', 'Bengaluru North City Corporation', 13.043018, 77.513049, 'sunitha@bbmp.gov.in'),
  ('SEC-BAG-1', 'Bagalagunte', 'Sector 1', 'Bengaluru North City Corporation', 13.062524, 77.499472, 'sunitha@bbmp.gov.in'),
  ('SEC-CBV-1', 'Chikkabanavara', 'Sector 1', 'Bengaluru North City Corporation', 13.074679, 77.505637, 'sunitha@bbmp.gov.in'),
  ('SEC-RRN-1', 'Rajarajeshwari Nagar', 'Sector 1', 'Bengaluru West City Corporation', 12.927441, 77.515522, 'admin@bbmp.gov.in'),
  ('SEC-KEN-1', 'Kengeri', 'Sector 1', 'Bengaluru West City Corporation', 12.917657, 77.483757, 'admin@bbmp.gov.in'),
  ('SEC-NGB-1', 'Nagarbhavi', 'Sector 1', 'Bengaluru West City Corporation', 12.951235, 77.519054, 'admin@bbmp.gov.in'),
  ('SEC-YPR-1', 'Yeshwanthpur', 'Sector 1', 'Bengaluru West City Corporation', 13.017694, 77.555501, 'admin@bbmp.gov.in'),
  ('SEC-LAG-1', 'Laggere', 'Sector 1', 'Bengaluru West City Corporation', 13.010868, 77.52073, 'admin@bbmp.gov.in'),
  ('SEC-HER-1', 'Herohalli', 'Sector 1', 'Bengaluru West City Corporation', 12.991234, 77.487012, 'admin@bbmp.gov.in'),
  ('SEC-SKN-1', 'Sahakara Nagar', 'Sector 1', 'Bengaluru North City Corporation', 13.062147, 77.580061, 'sunitha@bbmp.gov.in')
) as v(id, area, name, corporation, lat, lng, owner_email)
left join public.admins a on a.email = v.owner_email
on conflict (id) do nothing;
