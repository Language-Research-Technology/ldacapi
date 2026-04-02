# ldacapi
Implementation of Arocapi for Language Data Commons


```
npm install
docker compose up
npm run db:sync
npm run dev
```

index the data
curl -L -v -X POST -H "Authorization: Bearer <api_token>"  http://localhost:8080/admin/index/


LDACAPI_PORT default 8080
OPENSEARCH_URL http://localhost:9200