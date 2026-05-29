-- 1) Introduce the password directly to the trigger
SELECT set_config('app.password_plain', '12345Aa!.', true);

-- 2) Add users
INSERT INTO public.users (
    username,
    password_hash,
    role,
    name,
    surname,
    email,
    email_verified,
    is_verified,
    is_active
) VALUES
-- 1
('berk',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'hu@hacettepe.edu.tr',
 true,
 true,
 true
),
-- 2
('marco',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'marco@polimi.it',
 true,
 true,
 true
),
-- 3
('ibrahim',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'ibrahim@unimi.it',
 true,
 true,
 true
);