/**
 * CONFIGURATION
 */
export const BEARER_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJ3SmM4d2Yydi1PeFdrX1QxZ2F6OHlpeGhQayJ9.eyJhdWQiOiIzMmQ4NWI4YS1lOWI0LTQxZTUtYTM2Zi0yNDUzMDFlZjlkMGYiLCJleHAiOjE3NzA3MTQwNjMsImlhdCI6MTc3MDYyNzY2MywiaXNzIjoibnNtLWRldi5uYy52ZXJpZmkuZGV2Iiwic3ViIjoiZmJiY2Y5NTYtNGMxZC00MGM0LWFlZGQtZjY0MGYzZWE2ZDBjIiwianRpIjoiZDdhM2RkOWUtZGFmYS00ODMxLWIyYjctZjc0OWEzZGRhZWExIiwiYXV0aGVudGljYXRpb25UeXBlIjoiUEFTU1dPUkQiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJydXBpbkB3ZWJpbnRlbnNpdmUuY29tIiwiYXBwbGljYXRpb25JZCI6IjMyZDg1YjhhLWU5YjQtNDFlNS1hMzZmLTI0NTMwMWVmOWQwZiIsInJvbGVzIjpbXSwic2lkIjoiNzlkYzNjNDgtMjZkOS00NjMxLTlmM2MtMDZkNGYxM2FmMDM0IiwiYXV0aF90aW1lIjoxNzcwNjI3NjYzLCJ0aWQiOiJmMTNmYWFkNi01NjEzLTQzMjctYmM2Ni1iZmNhYWVmODlhZTAifQ.A_pzfgW78IYqr2677MBXmRHJN78kmRS4RPn0W_MisqcDYeZehiTlChgRlA6vJVELqFDJkMTmPgwTh8JjwiZkbQELRqIYV8BXsqFOuEM6QF5ubnCFK44aWnV4Sph1LoF3-ZjNs_hzRD2bHGW7xCjXedWgQePl8I07Vt0g_aIfxX3Z-Tw0kudXWeDTvhvZGVa7Jxvo9tXejKoKK_Pq0V7WkMK4GgWXHGpPLeHTdaEvi9ByFoSWNocJtXjNPBRwyf8L_CwR_4uNJ8a9G_Dhh6256NUQ_80-87AgJh8wy26r-BMkiE3dyzCybp1J6hod7QFWq39seM76glkJzR4kENLazg";
export const COOKIES = "<PLACEHOLDER>";
export const BASE_URL = "https://nsm-dev.nc.verifi.dev/rest/api/pagedesigner";
export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";

export const HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "authorization": BEARER_TOKEN.startsWith("Bearer ") ? BEARER_TOKEN : `Bearer ${BEARER_TOKEN}`,
  "Cookie": COOKIES,
};

export const TARGET_PAGE_IDS = [
  "49fa2576239ec5791c6ead4cf9408ce2",
  "4de7b4e1d21334bf2d8884b4086d38db",
  "415355f8d953fbc6ae2b9d3512822b72",
  "4f421358a8d8711bb6debc9d41f22a8d",
  "468a56c46dc20636301a9edb2c065b6d",
  "47df79ae8237c9165bf6b9e4a1211f4c",
  "472742e0b65e755ed9d5aa4bd92ef1da",
  "43b53167fc27f1e019739992da2f30af"
];